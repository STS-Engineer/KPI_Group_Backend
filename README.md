# KPI_Group_backend

Nouveau backend API (Node.js/Express) pour KPI_Group, en cours de migration
progressive depuis le monolithe original.

Voir `MIGRATION_MAP.md` (à la racine de `KPI Project`) pour le suivi de la
migration route par route.

## Authentification et administration des utilisateurs

Seules deux interfaces exigent une connexion : le Responsible KPI Dashboard
(`/responsible/:id/dashboard`) et l'administration des utilisateurs. Toutes les
autres pages restent ouvertes comme avant, en particulier celles ouvertes
depuis un lien reçu par mail (`/form`, `/dashboard`, `/kpi-training-center`,
`/kpi-target-adjustments/review`…).

Côté API, seules les routes de ces deux interfaces sont protégées : la liste
exacte est `PROTECTED_ROUTES` dans `src/middlewares/auth.middleware.js`. Toute
route qui n'y figure pas reste publique. Les routes `/api/admin/*` exigent en
plus le rôle `admin`.

`GET/PUT/DELETE /api/kpis/:id` restent publiques, même si le dashboard les
utilise, parce que la page ouverte `/kpi-admin` en a besoin.

### Mise en route

Les tables (`kpi_app_user`, `kpi_app_session`, `kpi_app_password_token`,
`kpi_app_auth_event`) sont créées automatiquement au démarrage. Elles ne
modifient aucune table existante ; `people` est seulement lue.

Pour créer le premier administrateur (le mot de passe est demandé en saisie masquée) :

```
npm run create-admin -- --email prenom.nom@avocarbon.com
```

Avec `--invite` à la place, le script envoie un mail d'invitation. Si l'envoi
échoue, il affiche le lien à transmettre.

### Fonctionnement

| Sujet | Règle |
|---|---|
| Rôles | `user`, `plant_manager`, `zone_manager`, `vp`, `ceo`, `admin`. Seul `admin` accède à l'administration. Les autres règlent ce que l'on voit dans « My KPI Analytics » (filtres unité / responsable) : ses propres KPI (`user`), plus les responsables de son usine (`plant_manager`) ou des usines de sa zone (`zone_manager`), plus tous les responsables (`vp`, `ceo`, `admin`). L'usine ou la zone vient des affectations actives de `people_role_assignment` (« Plant manager », « Zone managers »), sinon de l'unité de travail de la personne ; l'unité d'un responsable est son `work_at_unit_id`. Le serveur applique ce périmètre (`services/kpiAnalyticsScope.service.js`). La contrainte `kpi_app_user_role_check` est mise à jour au démarrage. |
| Compte et personne | Tout compte sauf un administrateur est lié à une personne de `public.people` : choisie par l'administrateur, sinon celle qui a le même e-mail. |
| Dashboard de chacun | Après connexion, l'utilisateur arrive sur `/responsible/<son people_id>/dashboard` (ex. 2284 pour Ahmed HORRI). Il ne peut ouvrir que le sien : l'API répond 403 `NOT_OWN_DASHBOARD` pour un autre id. Les administrateurs peuvent ouvrir tous les dashboards. |
| Session | Cookie `kpi_session` HttpOnly, SameSite=Lax (Secure en production). Seul le SHA-256 du jeton est stocké. Expire après 2 h d'inactivité, 12 h au maximum. |
| Mot de passe | Haché en scrypt. Au moins 10 caractères, avec une minuscule, une majuscule et un chiffre, sans le nom de l'e-mail. |
| Échecs de connexion | Message identique pour un e-mail inconnu ou un mauvais mot de passe. Compte verrouillé 15 min après 5 échecs ; limitation de débit par compte et par IP. |
| Mot de passe oublié | Réponse identique, que le compte existe ou non. Lien à usage unique valable 60 min ; toutes les sessions du compte sont fermées après la réinitialisation. |
| Invitation | Lien valable 72 h. L'administrateur peut aussi fixer un mot de passe temporaire, que l'utilisateur doit changer à sa première connexion. |
| CSRF | Requêtes d'écriture avec cookie refusées si l'en-tête `Origin` n'est pas dans `FRONTEND_URL`. |
| Garde-fous admin | Il reste toujours au moins un administrateur actif ; un admin ne peut ni se rétrograder, ni se désactiver, ni se supprimer. |
| Audit | Connexions, échecs, réinitialisations et actions d'administration sont enregistrés dans `kpi_app_auth_event`, consultables dans l'onglet « Activity log ». |
| Traçabilité KPI | Chaque création, modification ou suppression d'un KPI ou d'une target allocation faite par cette application (Responsible KPI Dashboard, page `/kpi-admin`, approbation d'un ajustement de cible) est enregistrée dans `kpi_app_change_log` : quoi, quand, par qui (compte connecté, approbateur du lien, sinon anonyme + IP) et, pour une modification, les champs changés (avant → après). L'écriture se fait dans la même transaction que le changement (`services/kpiChangeLog.service.js`). Onglet « KPI audit trail », administrateurs seulement. Les changements faits par le monolithe en production ou directement en SQL ne sont pas tracés. |

Variables d'environnement : voir `.env.example` (section Authentification).
Derrière le proxy Azure, mettre `TRUST_PROXY=1` pour que la limitation par IP
et le journal voient la vraie adresse du client.

## Saisie des KPI et des target allocations (`/kpi-intake`)

Page ouverte à toute personne qui a le lien : les responsables y saisissent de
nouveaux KPI et de nouvelles target allocations dans deux tableaux (onglets
« KPI » et « Target Allocation »), avec des noms au lieu des ids. Un
administrateur relit les lignes puis les soumet dans `public.kpi` et
`public.kpi_target_allocation`. Seules des créations sont possibles : aucune
ligne existante n'est modifiée.

| Sujet | Règle |
|---|---|
| Attente | Les lignes enregistrées sont stockées dans `kpi_app_intake_row` (créée au démarrage ; une seule table pour les deux onglets, valeurs en JSON). Rien n'est écrit dans `kpi` ni dans `kpi_target_allocation` avant le Submit. Statuts : `pending` (prête), `error`, `duplicate`, puis `submitted` (`created_record_id` = id créé) ou `rejected`. |
| Colonnes | Définies une seule fois dans `services/kpiIntakeColumns.js` : la page construit ses tableaux à partir de cette liste, et le serveur vérifie chaque ligne selon cette même liste (type, obligatoire, obligatoire selon une autre colonne, longueur maximale de la colonne en base). Les ids, `created_at`, `updated_at`, `is_active`, la base de connaissance et le fichier ne sont pas saisis ; `created_by_people_id` = la personne du champ « Submitted by ». |
| Noms → ids | `services/kpiIntakeResolver.service.js`. Un nom choisi dans la liste porte son id, vérifié à nouveau. Un nom tapé ou collé depuis Excel est comparé sans tenir compte de la casse, des accents, des espaces ni du type de tiret : d'abord avec le libellé complet, ensuite avec le nom seul. Aucune correspondance → « Unknown », plusieurs → « Ambiguous » avec les candidats ; jamais de choix silencieux. Les noms n'étant pas uniques (« Finance » existe dans chaque usine, homonymes chez les personnes et les clients), les libellés les distinguent : « Finance — Kunshan », « Prénom NOM — e-mail », « Client [code] — pays (#id) ». Plant = unité qui n'est pas un Department ; seuls les sujets finaux actifs, les rôles actifs et les clients non supprimés sont proposés. Les personnes et les clients sont cherchés côté serveur (2 lettres minimum, 20 résultats), jamais listés en entier. |
| Règles existantes | Une ligne passe aussi par `prepareKpiWritePayload` / `prepareKpiObjectPayload`, comme le formulaire `/kpi-admin` et le dashboard. L'INSERT d'un KPI est partagé avec `POST /api/kpis` (`insertKpiRow`, `models/kpi.model.js`). |
| Doublons | KPI : même nom + sous-titre qu'un KPI existant (actif ou non) ou qu'une ligne précédente. Allocation : même KPI et même périmètre (plant, zone, unit, unit type, role, set by, product, product line, market, customer, function) qu'une allocation active, non `Inactive`, ou qu'une ligne précédente, avec des périodes qui se chevauchent (une date absente = période ouverte). Un doublon n'est jamais inséré ni fusionné avec la ligne existante. |
| Dépendances | Une allocation peut viser un KPI saisi dans l'onglet KPI avant qu'il n'existe ; elle attend que cette ligne soit prête, et le Submit insère les KPI avant les allocations. |
| Écritures publiques | `GET /api/kpi-intake/lookups`, `/people`, `/customers`, `/lines`, `POST /api/kpi-intake/lines`, `DELETE /api/kpi-intake/lines/:id` : limitées par IP (600 lectures et 120 écritures par 15 min), 2 Mo et 200 lignes au maximum par enregistrement. Une ligne modifiée par quelqu'un d'autre entre-temps est refusée (409, `row_version`). |
| Administrateur | `GET /api/admin/kpi-intake/preview` (aperçu, n'écrit rien), `POST /api/admin/kpi-intake/submit` (`intake_ids` optionnel), `POST /api/admin/kpi-intake/reject` (`intake_ids`, `comment`). Le Submit s'exécute en une seule transaction, sous un verrou consultatif : si une ligne échoue, rien n'est inséré. Les créations sont tracées dans `kpi_app_change_log` (source `intake`) et la base de connaissance des KPI est mise à jour. |

## Assistant IA (bouton « AI » de toutes les pages)

Un bouton en bas à droite de chaque page du frontend ouvre un chat. L'assistant
explique les boards et les règles KPI, et lit les données réelles de
l'utilisateur connecté par appel de fonctions OpenAI (streaming).

| Sujet | Règle |
|---|---|
| Accès | `POST /api/assistant/chat` est public, comme les pages. Sans session : explication de l'application et du catalogue KPI seulement (outil `find_kpis`), rien n'est enregistré. Avec session : ses KPI, et ceux de son périmètre pour plant / zone manager, VP, CEO et admin — la même règle que « My KPI Analytics » (`kpiAnalyticsScope.service.js`), appliquée dans le code des outils, jamais par le prompt. |
| Outils (lecture seule) | `services/appAssistantTools.service.js` : dernier résultat et statut de chaque allocation, historique mensuel d'un KPI, target allocations, actions correctives (base Action Plan), base de connaissance d'un KPI, formations de l'utilisateur, personnes du périmètre. Le statut (on / off target) est calculé comme sur le dashboard (`getDashboardSubmissionStatus`). Aucun outil n'écrit. |
| Connaissance | `services/appAssistantKnowledge.js` : la liste des boards (liens, accès, mode d'emploi), les règles KPI, la page où se trouve l'utilisateur. À mettre à jour quand un board change. |
| Conversations | `kpi_app_assistant_conversation` (créée au démarrage, supprimée avec le compte). `GET /api/assistant/conversations[/:id]` et `DELETE …/:id` sont des routes protégées : chacun ne voit que les siennes. |
| Réponse | Flux SSE : `tool` (recherche en cours / terminée), `delta` (texte), puis `done` (`conversation_id`, `answer`, `suggestions`) ou `error`. Bouton Stop : la partie déjà écrite est conservée. |
| Limites | 60 questions par compte et 20 par IP sans session, par 15 minutes ; 4 000 caractères par question ; 5 tours d'outils au plus par réponse. |
| Modèle | `KPI_ASSISTANT_MODEL` (défaut `gpt-4o-mini`), clé `SECRET_KEY` comme le reste de l'application. |

### Tests

`npm test` lance les tests du parcours complet sur une base PostgreSQL en
mémoire (`pg-mem`), avec un faux serveur mail. Ils ne touchent ni la base de
production ni la messagerie.

### Lancer le backend en local

Ce backend partage la base de production. Mettre `DISABLE_CRON_JOBS=true` pour
qu'il n'envoie pas les mails hebdomadaires de soumission KPI. Sans cela, il
enregistrerait aussi l'envoi dans le journal partagé avec la production.
