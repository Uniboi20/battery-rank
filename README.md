# battery-rank

PowerRank — an independent value ranking of portable power stations and power banks.

## Amazon Associates setup

1. Put your Associates tracking ID in `config.js` (`AFFILIATE_TAG`). Every product link gets
   `?tag=…`, and the "As an Amazon Associate I earn from qualifying purchases" disclosure turns on
   across the site (header strip, footer, About, Privacy). While it's empty, pages say the site is
   not affiliated.
2. Keep these rules in mind when changing the site (Associates Program Policies):
   - **Don't display Amazon prices** unless they come from PA-API / Creators API (or an
     Amazon-served widget). Prices in Supabase are entered by hand, so they're used only as a
     scoring input and for the budget filter, never shown.
   - No price tracking or price alerts, no Amazon star ratings or reviews, and no scraping Amazon.
   - Don't cloak or shorten Amazon links; they should clearly go to Amazon.
   - Keep the privacy policy's third-party cookie disclosure.
