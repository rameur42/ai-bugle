# AI veille

Veille IA/tech en français, le lundi et le jeudi à 08:17 (Paris) par GitHub Actions : postée sur
Discord et publiée sur un site statique (GitHub Pages, installable sur mobile).

Sources : arXiv (toute la fenêtre d'annonce), HF Daily Papers, modèles tendance Hugging Face,
OpenRouter, Hacker News, GitHub, blogs de labos, Reddit (optionnel). Claude rédige le brief via
Claude Code, sur l'abonnement Claude Pro/Max (pas de facturation API).

## Fonctionnement

1. `scripts/daily/veille.ts` collecte les sources et demande à Claude un brief **structuré** (JSON,
   via `claude -p --json-schema`) : par news, un titre, le texte, 1 à 3 sources et 2 à 4 notions clés.
2. La veille est écrite dans `site/veilles/AAAA-MM-JJ.json`, puis `site/veilles/index.json` est
   reconstruit à partir de toutes les veilles.
3. Le même JSON est rendu en Markdown pour Discord (messages ≤ 2 000 caractères, aperçus de liens
   désactivés), avec un lien vers la page de la veille sur le site.
4. Le workflow commit le JSON, puis déploie `site/` sur GitHub Pages.

Le site (`site/`, HTML/CSS/JS sans build) : liste des veilles, une page par veille (L'essentiel,
Papiers, Sorties, Pour approfondir), bouton 🔎 Google par news, notions cliquables, et un bouton
flottant « Rechercher sur Google » quand on sélectionne du texte. Lu / non lu est gardé dans le
navigateur (pas de compte, pas de synchronisation).

## Configuration

Settings → Secrets and variables → Actions :

| Nom | Type | Rôle |
|---|---|---|
| `VEILLE_DISCORD_WEBHOOK_URL` | secret | Webhook du salon (Paramètres du salon → Intégrations → Webhooks) |
| `CLAUDE_CODE_OAUTH_TOKEN` | secret | Active le brief ; créé en local avec `claude setup-token`. Ne pas ajouter `ANTHROPIC_API_KEY` |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` | secrets, optionnels | Reddit bloque les IP de CI sans OAuth |
| `VEILLE_MODEL` | variable, optionnelle | Défaut `claude-sonnet-5-5` |
| `VEILLE_REQUIRE_DISCORD` | variable, optionnelle | Défaut `true` : l'exécution échoue sans webhook |

Settings → Pages → Source : **GitHub Actions** (une fois). Site :
`https://<propriétaire>.github.io/<dépôt>/`.

Test : Actions → « AI veille — Monday & Thursday » → Run workflow, **depuis `main`** : l'environnement
`github-pages` n'accepte que la branche par défaut, donc un lancement depuis une autre branche échoue à
l'étape de publication.

## En local

- Veille : `bun scripts/daily/veille.ts` (ou `node scripts/daily/veille.ts`, Node ≥ 23.6) avec
  `claude` connecté. Sans webhook, le digest s'affiche dans le terminal ; le JSON est écrit dans
  `site/veilles/` (`VEILLE_WRITE_JSON=false` pour ne rien écrire, `VEILLE_OUT_DIR` pour un autre dossier).
- Site : `python3 -m http.server -d site 8000`, puis http://localhost:8000.
- Tests : `node --test scripts/daily/brief.test.ts`.
- Icônes : `node scripts/site/icons.ts` régénère les PNG de `site/icons/`.

## Choix techniques

- **Claude ne fournit jamais d'URL** : chaque item brut reçoit un identifiant court (`i12`), Claude
  cite ces identifiants et le script les remplace par les vrais liens. Un lien peut manquer, jamais
  être inventé.
- **JSON imposé par `--json-schema`** : la réponse validée arrive dans `structured_output`.
- **Données dans `site/veilles/`** : le dossier publié est servi tel quel, en local comme sur Pages.
- **Une veille relancée le même jour remplace** le fichier du jour.
- **PWA en `display: standalone`** : plein écran sans barre de navigateur, en gardant la barre
  d'état du téléphone. Service worker « réseau d'abord » : toujours la dernière veille, et les
  veilles déjà ouvertes restent lisibles hors ligne.
- **Deux jobs** : `digest` (collecte + Claude + Discord) tourne en lecture seule, car il traite du
  texte venu de flux externes ; `publish` (commit du JSON + déploiement Pages) est le seul à avoir le
  droit d'écrire. Le JSON passe de l'un à l'autre par un artefact.
- **Le commit du JSON a lieu même si le post Discord échoue**, et le site est publié quand même ;
  l'exécution reste rouge pour signaler l'échec Discord.
- **Liens Hacker News** : la puce source porte le nom du site de l'article, et une seconde puce
  « Hacker News (discussion) » ouvre le fil HN.
- Scripts compatibles Bun (CI) et Node ≥ 23.6 (imports `.ts` explicites, zéro dépendance).
