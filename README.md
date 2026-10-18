# AI veille

Veille IA/tech en français, postée sur Discord le lundi et le jeudi à 08:17 (Paris) par GitHub Actions.

Sources : arXiv (toute la fenêtre d'annonce), HF Daily Papers, modèles tendance Hugging Face,
OpenRouter, Hacker News, GitHub, blogs de labos, Reddit (optionnel). Claude rédige le brief via
Claude Code, sur l'abonnement Claude Pro/Max (pas de facturation API).

## Configuration

Settings → Secrets and variables → Actions :

| Nom | Type | Rôle |
|---|---|---|
| `VEILLE_DISCORD_WEBHOOK_URL` | secret | Webhook du salon (Paramètres du salon → Intégrations → Webhooks) |
| `CLAUDE_CODE_OAUTH_TOKEN` | secret | Active le brief ; créé en local avec `claude setup-token`. Ne pas ajouter `ANTHROPIC_API_KEY` |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` | secrets, optionnels | Reddit bloque les IP de CI sans OAuth |
| `VEILLE_MODEL` | variable, optionnelle | Défaut `claude-sonnet-5-5` |
| `VEILLE_REQUIRE_DISCORD` | variable, optionnelle | Défaut `true` : l'exécution échoue sans webhook |

Test : Actions → « AI veille — Monday & Thursday » → Run workflow.

En local : `bun scripts/daily/veille.ts` avec `claude` connecté (sans webhook, le digest s'affiche dans le terminal).
