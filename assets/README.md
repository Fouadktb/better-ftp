# Application icon

`app-icon.png` is the original generated master artwork. `app-icon-small.png` is the 64px interface derivative. Native macOS ICNS, Windows ICO, Linux PNG and Windows installer tiles live in `src-tauri/icons/`; the browser favicon is `public/icon.png`.

The master was created with the built-in image generation tool. Prompt:

> One production desktop application icon for Better FTP. A charcoal rounded square tile with two broad, interlocking horizontal transfer arrows pointing in opposite directions: upper arrow warm off-white, lower arrow vivid mint/teal. Balanced negative space subtly suggests B. Crisp geometric silhouette, readable at small sizes, restrained developer-tool aesthetic, nearly flat finish with a subtle edge highlight, transparent outside corners. No text, folder, cloud, server illustration, device mockup, multiple variants, or watermark.

Generate platform derivatives with:

```sh
npx tauri icon assets/app-icon.png --output src-tauri/icons
cp src-tauri/icons/64x64.png assets/app-icon-small.png
cp src-tauri/icons/32x32.png public/icon.png
```

Only desktop derivatives are used by this project. The app icon is part of this MIT-licensed project.
