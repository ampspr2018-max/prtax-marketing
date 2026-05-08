# prtax-marketing

Static marketing site for PR Tax Consultants, deployed to Cloudflare Pages.

## Structure

```
prtax-marketing/
├── index.html                      # Marketing landing page
├── assets/
│   ├── logo-blanco-transparent.png
│   ├── logo-dark-bg.png
│   ├── logo-on-dark.png
│   └── tailwind.js                 # Tailwind CDN bundle
├── .gitignore
└── README.md
```

## Deploy

The site is a pure static bundle — no build step. Cloudflare Pages serves
`index.html` from the repo root.

Pushing to `main` triggers an automatic deploy on Cloudflare Pages.
