# Order status UI (GitHub Pages)

This folder is published as the static UI loaded inside the Wix HTML component (iframe). Source of truth for edits is [`../src/iframe/dynamic-page`](../src/iframe/dynamic-page); run `npm run sync-docs-ui` after changing that file to refresh `index.html` here.

## Enable GitHub Pages

1. On GitHub: **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **Deploy from a branch**.
3. **Branch**: `main`, folder **`/docs`**, Save.
4. After a minute, the site is live at:

   `https://tonyboom3d.github.io/copy-of-titlewave/`

5. Velo uses this URL in `Items (List) (Item).q5v7m.js` as `IFRAME_URL`.

`.nojekyll` is present so GitHub Pages does not run Jekyll over this static HTML.
