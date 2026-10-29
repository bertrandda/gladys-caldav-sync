# CalDAV

Cette intégration copie vos calendriers **CalDAV** (Nextcloud, iCloud, Fastmail,
Baïkal, Radicale, SOGo, Synology Calendar…) dans le calendrier de Gladys. Les
événements apparaissent dans la vue calendrier, peuvent déclencher des scènes
(« un événement arrive ») et sont connus de l'assistant.

La synchronisation est **à sens unique** : Gladys lit votre serveur CalDAV, il
n'y écrit jamais. Un événement créé ou modifié dans Gladys sur un calendrier
synchronisé n'est pas renvoyé au serveur.

## Activer l'intégration pour votre compte

Chaque utilisateur de Gladys active l'intégration **pour lui-même** : vos
calendriers sont des données personnelles, rien n'est synchronisé tant que
vous ne l'avez pas activée.

1. Ouvrez l'intégration **CalDAV**, onglet **Configuration**.
2. Dans le bloc **Mes calendriers**, renseignez :
   - l'**URL du serveur CalDAV** (voir le tableau ci-dessous) ;
   - votre **nom d'utilisateur** ;
   - votre **mot de passe** — utilisez un **mot de passe d'application** si
     votre fournisseur en propose un.
3. Cliquez sur **Activer**. Vos calendriers apparaissent quelques secondes
   plus tard.

| Fournisseur | URL du serveur                                 | Remarques                                                    |
| ----------- | ---------------------------------------------- | ------------------------------------------------------------ |
| Nextcloud   | `https://cloud.exemple.fr/remote.php/dav`      | Mot de passe d'application : Paramètres → Sécurité           |
| iCloud      | `https://caldav.icloud.com`                    | Identifiant Apple + mot de passe d'application (obligatoire) |
| Fastmail    | `https://caldav.fastmail.com`                  | Mot de passe d'application avec l'accès CalDAV               |
| Baïkal      | `https://dav.exemple.fr/dav.php`               |                                                              |
| Radicale    | `https://dav.exemple.fr` (ou `http://ip:5232`) |                                                              |
| SOGo        | `https://mail.exemple.fr/SOGo/dav`             |                                                              |
| Synology    | `https://nas.exemple.fr:5001/caldav`           |                                                              |

L'intégration découvre elle-même vos calendriers depuis cette URL (principal
et dossier de calendriers) : inutile d'indiquer l'adresse de chaque calendrier.
Les listes de tâches sont ignorées.

## Choisir quoi synchroniser et partager

Chaque calendrier synchronisé apparaît dans Gladys avec deux interrupteurs :

- **Synchroniser** — désactivez-le pour ignorer un calendrier : ses événements
  sont retirés de Gladys. Réactivé, il est re-rempli à la synchronisation qui
  suit.
- **Partager** — un calendrier est **privé** au départ. Partagé, il devient
  visible par tout le foyer, et utilisable par les scènes.

Le nom, la description et la couleur d'un calendrier suivent ceux du serveur.

## Réglages (administrateur)

Ces réglages s'appliquent à tous les utilisateurs :

- **Intervalle de synchronisation** — toutes les 15 minutes par défaut (de 5
  minutes à 24 heures).
- **Jours d'historique** — les événements passés de plus de 30 jours (par
  défaut) ne sont pas synchronisés.
- **Jours à venir** — 365 jours par défaut (jusqu'à 730) : les événements
  récurrents sont développés jusqu'à cet horizon.

Le bouton **Synchroniser maintenant** relit immédiatement tous les comptes et
affiche le nombre de calendriers et d'événements synchronisés.

## Bon à savoir

- Un événement supprimé sur le serveur disparaît de Gladys à la
  synchronisation qui suit ; un calendrier supprimé sur le serveur est
  supprimé de Gladys avec ses événements.
- Les événements récurrents (y compris les exceptions et occurrences
  déplacées) sont développés en occurrences individuelles.
- Les événements annulés (`STATUS:CANCELLED`) ne sont pas importés.
- Un événement à heure « flottante » (sans fuseau horaire) est lu en UTC.
- Limites de Gladys : 50 calendriers par utilisateur, 10 000 événements par
  calendrier ; les textes trop longs sont tronqués.
- Désactiver l'intégration pour votre compte supprime de Gladys vos
  calendriers synchronisés (ils restent intacts sur le serveur).

## Dépannage

L'écran de configuration indique combien de comptes sont en échec. Les causes
les plus fréquentes :

- **URL incorrecte** — vérifiez l'URL dans un client CalDAV (Thunderbird,
  DAVx⁵) ; essayez l'URL racine du serveur, la découverte
  `/.well-known/caldav` est automatique.
- **Identifiants refusés** — avec la double authentification activée, un
  mot de passe d'application est indispensable.
- **Certificat auto-signé** — le serveur doit présenter un certificat HTTPS
  valide (ou être joint en HTTP sur le réseau local).

L'administrateur trouve le détail des erreurs dans les logs de l'intégration
(page de l’intégration, onglet de supervision). Les mots de passe n'y
apparaissent jamais.
