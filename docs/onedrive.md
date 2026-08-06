# Reading the workbook live from OneDrive

> **This is the setup page for the app's data source.**
>
> The app fetches the workbook anonymously from a public OneDrive share link. That
> requires a **personal** Microsoft account: Northeastern's tenant blocks
> anonymous sharing, and it also blocks the app registration that per-viewer
> sign-in would have needed (that approach was built, then removed — it is in git
> history).
>
> Sections 1–2 are what you follow. Sections 3–5 are the record of what was tested
> against the university link and why each route failed. Note that the CORS proxy
> in section 5 cannot fix a work-account link: that failure is authorization, not
> CORS.

The app can read `master_dataset_1_values_3.xlsx` straight from a public
OneDrive / SharePoint link, so viewers always see your latest edits without a
redeploy. This page covers how to set it up, how to test whether your link is
actually fetchable, and what to do when it isn't.

## 1. Share the workbook from a personal Microsoft account

Upload `master_dataset_1_values_3.xlsx` to the OneDrive of a **personal**
Microsoft account (outlook.com / hotmail.com / live.com — not a university or
work account), then share it as **"Anyone with the link"** and copy that link.

Both halves matter:

- **Personal account.** A work/university link lives on `*.sharepoint.com`, whose
  endpoints demand a tenant session and refuse anonymous callers outright. No
  proxy fixes that — see section 3.
- **"Anyone with the link".** A link scoped to an organisation returns an HTML
  sign-in page. The adapter detects that (an `.xlsx` is a zip and must begin with
  the bytes `PK`; an HTML page does not) and reports it rather than parsing a
  login form as data.

## 2. Point the app at it

In [`../src/config.js`](../src/config.js):

```js
export const CONFIG = {
  oneDriveShareUrl: 'https://1drv.ms/x/s!AbCdEfGhIjKl...',
  corsProxy: '',
  ...
};
```

Reload. The pill in the header tells you what loaded:

- **green · "Live · OneDrive"** — working. Hover it for the URL form that
  succeeded.
- **amber · "Local file (preview)"** — you are on `?local=1`, reading a local copy
  rather than the live link.

If the fetch fails there is no silent fallback: you get an error screen naming the
cause and the fix. It inspects your configured link too, so a `*.sharepoint.com`
URL is diagnosed as a work-account problem rather than mistaken for a CORS one.

## 3. Why it often doesn't work: CORS

A browser will only read a cross-origin response if that response carries an
`Access-Control-Allow-Origin` header. Anonymous OneDrive and SharePoint download
endpoints frequently omit it. When that happens the fetch fails inside the
browser's security layer — **no client-side code can work around it**; the app
reports it and points you at the proxy in section 5.

The adapter tries several URL forms, because which one works depends on whether
the file lives in OneDrive personal or OneDrive for Business / SharePoint:

| # | Form | Notes |
|---|---|---|
| 1 | `https://api.onedrive.com/v1.0/shares/u!<base64url>/root/content` | The share link base64url-encoded. Best odds for OneDrive **personal**; documented to send CORS headers. |
| 2 | `<share link>?download=1` | Works for direct downloads; commonly CORS-blocked. |
| 3 | `.../\_layouts/15/download.aspx?share=...` | SharePoint / OneDrive **for Business** form. Usually needs auth. |

A university account (for example `@northeastern.edu`) is OneDrive **for
Business**, backed by SharePoint. Those tenants are the most likely to block
anonymous cross-origin reads, and a tenant admin may disable anonymous sharing
entirely.

### Tested against this project's actual link (2026-08-04)

The `northeastern-my.sharepoint.com` link for this workbook was tested and **is
not anonymously readable**. All four candidate forms fail:

| Attempt | Result |
|---|---|
| Raw share link | `403 Forbidden`, with `X-Forms_Based_Auth_Required` pointing at the tenant login |
| `&download=1` | `403`, `X-MSDAVEXT_Error: Access denied. Before opening files in this location, you must first browse to the web site and select the option to login` |
| `api.onedrive.com/v1.0/shares/u!…` | `{"code":"userContentMigrated","message":"User migrated."}` — that endpoint serves OneDrive **personal** only |
| `graph.microsoft.com/v1.0/shares/u!…` | `401 InvalidAuthenticationToken` |

**This is an authorization failure, not a CORS failure** — and that distinction
decides what can fix it. A proxy solves CORS by re-serving a response the browser
refused to *read*. Here the server refuses to *send* the file at all, to anyone
without a Northeastern session. The Worker in section 5 would get the same 403,
so it cannot help.

Two ways forward:

1. **Re-share the file as "Anyone with the link."** In the OneDrive share dialog,
   change the audience from *People in Northeastern University* to *Anyone*. If
   that option is greyed out or absent, the tenant has disabled anonymous
   sharing and only IT can change it — universities commonly do disable it.
   Re-test with the `curl` in section 4 afterwards.
2. **Move the workbook to a personal Microsoft account** — what the project does
   now (section 1). Consumer OneDrive allows anonymous sharing without an
   administrator, and the `api.onedrive.com` endpoint that rejected the
   university link with `userContentMigrated` is the consumer one, so it is the
   form expected to work there.

## 4. Test your link before assuming

```bash
curl -sIL "https://1drv.ms/x/s!YOUR_LINK?download=1" | grep -i "access-control-allow-origin\|content-type\|^HTTP"
```

- `access-control-allow-origin: *` → live reading will work; nothing else to do.
- No such header → you need the proxy in section 5.
- `content-type: text/html` → you're being sent a sign-in page; re-check that the
  link is shared with **Anyone**.

You can also just set the URL and read the header pill's tooltip — it lists the
real failure for every candidate.

## 5. If it's blocked: a CORS proxy

GitHub Pages is static and cannot proxy, so the proxy has to live somewhere else.
A Cloudflare Worker on the free tier is enough. **Do not use a public
open-proxy service** — it would see your workbook.

```js
// worker.js — deploy at https://dash.cloudflare.com → Workers → Create
const ALLOWED = new Set([
  'https://YOUR-USER.github.io',   // your Pages origin
  'http://localhost:4173',         // local dev
]);

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED.has(origin) ? origin : 'null',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Vary': 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (!ALLOWED.has(origin)) return new Response('Forbidden origin', { status: 403, headers: cors });

    const target = new URL(request.url).searchParams.get('url');
    if (!target) return new Response('missing ?url=', { status: 400, headers: cors });

    // Only ever proxy Microsoft file hosts — never an arbitrary URL.
    const host = new URL(target).hostname;
    const ok = /(^|\.)(1drv\.ms|onedrive\.live\.com|api\.onedrive\.com|sharepoint\.com)$/.test(host);
    if (!ok) return new Response('Forbidden host', { status: 403, headers: cors });

    const upstream = await fetch(target, { redirect: 'follow' });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        ...cors,
        'Content-Type': upstream.headers.get('Content-Type')
          || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Cache-Control': 'public, max-age=300',
      },
    });
  },
};
```

Then in `src/config.js`:

```js
corsProxy: 'https://your-worker.your-subdomain.workers.dev/?url={url}',
```

The `{url}` placeholder is replaced with the percent-encoded target. The origin
and host allowlists are the point of the thing: without them you would be running
an open relay that anyone could aim at any URL.

## 6. Fallback: gate the site

If you ever need to restrict who can see the data, the route that needs no
administrator is to stop publishing the link and gate the site instead, with the
workbook bundled into it.

Outline, using Cloudflare Access on the free Zero Trust plan — it never touches
the university's identity provider, so IT cannot block it:

1. Commit the workbook and point the adapter at it locally. **Switch the
   repository to private** — the dataset is now inside it.
2. Deploy to Cloudflare Pages.
3. In **Zero Trust → Access controls → Applications**, create a *Self-hosted*
   application for your `*.pages.dev` hostname.
4. Add an **Allow** policy, rule type **Include**, selector **Emails ending in** =
   `@northeastern.edu`.
5. Add **One-time PIN** as a login method — it is *not* enabled by default on new
   Zero Trust organizations. Viewers enter their email and receive a single-use
   code.

Two things to get right:

- The Pages project's own "Enable access policy" toggle protects **preview
  deployments only**. To cover the production `*.pages.dev` hostname, edit the
  generated Access application and remove the wildcard `*` from its subdomain, so
  you end up with two applications.
- Do **not** write the policy as `Login Methods = One-time PIN`. Cloudflare's docs
  list that as a misconfiguration that lets anyone in. Gate on **Emails ending
  in**; OTP is only *how* people log in.

Trade-offs versus the current setup: the dataset then sits at rest on a third
party, it is only as fresh as your last `refresh.py` and push, and anyone who can
receive `@northeastern.edu` mail gets in.

## Embedding the workbook next to the app

If what you want is for viewers to *see* the live spreadsheet alongside the
explorer, OneDrive's **Embed** option gives an `<iframe>` snippet that renders the
actual sheet in Excel for the web. That is independent of the CORS question — the
iframe is Microsoft's own viewer, not a fetch — so it works even when live reading
does not. Drop it into `index.html` as another card, or just link to the workbook.
