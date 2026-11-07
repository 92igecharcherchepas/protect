# Protect AntiRaid

Bot Discord autonome en `discord.js` 14.

Toutes les réponses, le panneau et les journaux utilisent les composants Discord V2 dans des conteneurs gris. Les salons de logs n’ont donc pas besoin de la permission **Intégrer des liens**.

## Installation

1. Dans le portail Discord, active les intents privilégiés **Server Members Intent** et **Message Content Intent**.
2. Crée `protect/.env`, puis renseigne `DISCORD_TOKEN` et `CLIENT_ID`. Pour un déploiement immédiat sur un serveur de test, renseigne aussi `GUILD_ID` (son identifiant). Ajoute les identifiants dans `PROTECT_OWNER_IDS` et `PROTECT_BUYER_IDS` si nécessaire.
3. Depuis ce dossier, installe les dépendances avec `npm install`.
4. Depuis le dossier `protect`, exécute `npm run deploy`. Avec `GUILD_ID`, les commandes sont enregistrées immédiatement sur ce serveur ; sans lui, elles sont globales et peuvent prendre jusqu’à une heure à apparaître. Démarre ensuite avec `npm start`.
5. Invite (ou réinvite) l’application dans le serveur avec les scopes `bot` et `applications.commands`. Pour restaurer et modérer, elle a besoin notamment de **View Audit Log**, **Manage Channels**, **Manage Roles**, **Moderate Members**, **Kick Members**, **Ban Members**, **Manage Webhooks** et **Move Members** selon les modules utilisés.

Si les commandes ne s’affichent toujours pas, vérifie que `CLIENT_ID` correspond à l’application dont le token est utilisé, que le bot est bien présent dans le serveur indiqué par `GUILD_ID`, et que tu as relancé `npm run deploy` depuis ce dossier. Le terminal doit confirmer le nombre de commandes déployées. Dans Discord, essaie aussi `/panel` dans un salon où l’application a accès.

Le fichier `data/guilds.json` est créé à la première sauvegarde de configuration et contient les réglages de chaque serveur. Les modules sont initialement désactivés. `/on` active tous les modules ; `/off` les désactive. `/panel` permet de choisir les modules et la sanction, et `/limit` règle leur seuil (dans une fenêtre de 10 secondes).

## Commandes principales

- `/panel`, `/on`, `/off`, `/limit`, `/info bypass`
- `/multi logs` crée automatiquement un salon privé dans le serveur indiqué par `serveur_id`. Choisis `Tous les modules` pour créer un salon distinct par module (`#antiraid-channelcreate`, `#antiraid-roledelete`, etc.), ou un module particulier pour ne créer/configurer que son salon. Les salons déjà créés/configurés sont réutilisés. Le bot doit être membre du serveur de logs et y avoir la permission **Gérer les salons**.
- `/owner`, `/shield` et `/wl` pour gérer les owners, membres protégés et exceptions
- `/acces configurer` ouvre un panneau de menus déroulants : choisis une catégorie, puis un ou plusieurs rôles giveaway. Dans cette catégorie, `@here` et les rôles choisis ne sont pas soumis à la limite AntiRaid. `/acces liste` affiche les règles et `/acces retirer` supprime les exceptions d’une catégorie.
- `/profil` est réservé aux identifiants `PROTECT_OWNER_IDS`
- `/reset` est réservé aux identifiants `PROTECT_BUYER_IDS`

Le bot applique une politique restrictive : le propriétaire du serveur et les owners configurés contournent les protections ; une entrée whitelistée contourne seulement son ou ses modules ; Shield protège les cibles des actions surveillées. Les administrateurs ne sont pas automatiquement exemptés.

## Limites Discord à connaître

La restauration dépend des informations disponibles dans les journaux d’audit et des permissions/rôles du bot. Les salons et rôles supprimés peuvent être recréés, mais Discord ne permet pas de récupérer automatiquement toutes les anciennes appartenances à un rôle supprimé. Une expulsion ne peut pas être annulée. Les changements de serveur, timeout, fils, webhooks et certaines modifications ne fournissent pas toujours assez de données d’audit pour reconstituer leur état antérieur. Teste les réglages sur un serveur de test avant activation en production.
