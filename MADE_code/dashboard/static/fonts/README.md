# Local interface fonts

- Inter Variable (100–900), from the Google Fonts Inter distribution.
- JetBrains Mono Variable (100–800), from the Google Fonts JetBrains Mono distribution.
- Both use the SIL Open Font License; the corresponding OFL files are included here.

Sources:

- https://github.com/google/fonts/tree/main/ofl/inter
- https://github.com/google/fonts/tree/main/ofl/jetbrainsmono

`workspace.css` loads these files locally with `font-display: swap`. The dashboard does not send font requests to external services. System sans-serif and monospace fonts remain available as fallbacks.
