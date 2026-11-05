// "Continue with Microsoft": the exchanges with Microsoft Entra ID
// (authorization code flow with PKCE, @azure/msal-node). Who may then sign in
// is decided by auth.service.js (signInWithMicrosoft).
//
// startSignIn() gives the Microsoft URL to send the browser to and the values
// to keep until it comes back (state, PKCE verifier, nonce -- the router keeps
// them in a short-lived HttpOnly cookie, so nothing lives in server memory).
// completeSignIn() exchanges the code Microsoft returned and gives the claims
// of the ID token, after checking its nonce and tenant.

const crypto = require("crypto");

const SCOPES = ["openid", "profile", "email"];

const randomValue = () => crypto.randomBytes(32).toString("base64url");

const createMicrosoftAuth = ({ config, msal = require("@azure/msal-node") }) => {
  const settings = config.microsoft || {};
  const pkce = new msal.CryptoProvider();
  let client = null;

  // Built on first use, so the server starts without the AZURE_* settings.
  const getClient = () => {
    if (!client) {
      client = new msal.ConfidentialClientApplication({
        auth: {
          clientId: settings.clientId,
          authority: `https://login.microsoftonline.com/${settings.tenantId}`,
          clientSecret: settings.clientSecret
        }
      });
    }
    return client;
  };

  const startSignIn = async () => {
    const state = randomValue();
    const nonce = randomValue();
    const { verifier, challenge } = await pkce.generatePkceCodes();
    const url = await getClient().getAuthCodeUrl({
      scopes: SCOPES,
      redirectUri: settings.redirectUri,
      state,
      nonce,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      responseMode: "query",
      // Always the "Pick an account" page, as in the other AVOCarbon apps.
      prompt: "select_account"
    });
    return { url, transaction: { state, verifier, nonce } };
  };

  const completeSignIn = async ({ code, verifier, nonce }) => {
    const result = await getClient().acquireTokenByCode({
      code,
      scopes: SCOPES,
      redirectUri: settings.redirectUri,
      codeVerifier: verifier
    });
    // Only the identity is needed: nothing is kept in MSAL's in-memory cache.
    if (result.account) await getClient().getTokenCache().removeAccount(result.account).catch(() => {});

    const claims = result.idTokenClaims || {};
    if (!nonce || claims.nonce !== nonce) throw new Error("The ID token nonce does not match the sign-in request.");
    if (String(claims.tid || "").toLowerCase() !== settings.tenantId.toLowerCase()) {
      throw new Error("The Microsoft account belongs to another organization.");
    }
    return claims;
  };

  return { enabled: Boolean(settings.enabled), startSignIn, completeSignIn };
};

// The e-mail may be in any of these claims depending on the tenant;
// preferred_username / upn (the login name) is not always the mail address,
// so each one is tried against the accounts and public.people.
const getEmailCandidates = (claims = {}) => [
  ...new Set(
    [claims.email, claims.preferred_username, claims.upn]
      .filter(Boolean)
      .map((value) => String(value).trim().toLowerCase())
      .filter((value) => value.includes("@"))
  )
];

// Microsoft's error description carries the actual reason as an AADSTS code.
const getAadstsCode = (text) => /AADSTS\d+/.exec(String(text || ""))?.[0] || null;

module.exports = { createMicrosoftAuth, getEmailCandidates, getAadstsCode };
