# Feel Good

Mood check-in web app.

- **App:** served by GitHub Pages from this repo's `main` branch → https://trevco623.github.io/feel-good/
- **Server functions** (`netlify/functions/`): Claude AI calls, moods proxy, themes, Oura connect/sync/disconnect. These still run on Netlify at https://feelgoodapp.netlify.app and only need redeploying to Netlify when a function changes. Don't link Netlify to this repo — every push would become a paid production deploy.
- **Data + auth:** Supabase.
