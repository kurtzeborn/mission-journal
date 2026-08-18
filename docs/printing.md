# Getting a book printed

Journal Publish assembles a hardcover book from a missionary's letters and photographs. Assembling it is our problem; printing, binding and posting it is somebody else's. This is the record of who that somebody should be, and — more usefully in a year's time — why the ones we did not pick were not picked.

An earlier version of this comparison lived in [plan.md](plan.md) and recommended Lulu. It was written before the constraint that decides the whole question, and it is wrong. This file replaces it.

## What actually decides it

Three requirements, in order of how much they narrow the field.

**We do not take payments and we do not hold delivery addresses.** pdayletters.com has no card processing, no PCI surface, no merchant account, and no wish to acquire any. A name, a street address and a phone number for somebody who is not even a member of the site is a category of data this service has deliberately never stored. Whoever prints the book has to be the one who sells it, which means they are the merchant of record and the reader's details are theirs, not ours.

That is a stronger constraint than it looks. Most print-on-demand APIs are wholesale: you send them a PDF *and* a shipping address, they invoice you, you charge the customer yourself. That model requires precisely the two things we will not do.

**Some money has to come back.** Not profit — the site costs a few dollars a month in Azure and Cloudflare and the goal is to cover that. But a provider that returns nothing at all means the one planned source of income for the site is not a source of income.

**It has to feel like a feature of this site.** The owner presses a button, waits, and is told the book is ready to look at. "Download a zip and go re-upload it somewhere else" is not that. So the provider needs an API we can hand a finished PDF to, and a checkout we can send the owner into without building a shop.

Two further requirements that eliminate less but matter:

**It cannot be a public storefront.** These are family letters and photographs of children. A provider whose only revenue-sharing route is listing the book for sale to the general public is a provider we cannot use, whatever the terms.

**The book is private, so the PDF has to stay private.** Whatever URL the printer fetches has to be gated tightly enough that it is not a public archive of somebody's mission.

## The three shapes on offer

Every provider in the market is one of these. The shape decides the verdict; the details only decide the ranking within a shape.

### A — Hosted checkout: the buyer pays the printer, we take the margin

We upload a PDF, they give us a checkout link, the buyer pays them, they print and ship and deal with the customer, and they pay us the difference between our price and their cost. No card handling here, no addresses here, no support burden here.

This is the only shape that satisfies all three hard requirements.

### B — Wholesale API: we pay, and become the merchant of record

We send the PDF and the reader's shipping address, they invoice us, we recover the money ourselves. Requires the payment surface and the PII store we have refused to build. **Fails on the first requirement.**

### C — Affiliate link only

A referral link into somebody's consumer photo-book builder. The owner starts again from nothing: re-uploads photographs, re-lays out pages, and everything this book engine does is thrown away. Commission is a few percent on whatever fraction of clicks convert within a cookie window. **Fails on the third requirement**, and mostly on the second too.

## The candidates

### Peecho — recommended

A Dutch print-on-demand platform, now part of the Prodigi group. Category A, and built for exactly this: an app that has content its users want on paper.

- **Products.** Hardback, softback and layflat books, magazines, calendars. Layflat matters for a photo book — a two-page spread of photographs across a normal perfect binding loses its middle to the gutter.
- **Integration.** A Print API for uploading the PDF and creating the product, plus a hosted checkout. Their words on the checkout: *"Supports all major payment methods, handles taxes, and comes with promotional discount codes as standard."* That sentence is the entire reason to choose them — every clause in it is work we are not doing.
- **The money.** Their seller terms define *Profit* as *"the amount of money per order to be paid to the client after the cost of production, shipping, relevant VAT and sales tax charges, and transaction fees have been deducted from the final price displayed in the checkout"*, withdrawn on request from their dashboard. We set the price, they take their costs, the rest is ours. No affiliate approval, no cookie window, no attribution to lose.
- **Support.** Their terms: *"PEECHO will provide PEECHO Customer Services to Client and Customer... PEECHO addresses case issues regarding Items and/or Orders with the Printer and communicates the outcome to the Customer."* A book that arrives damaged is not an email to us.
- **Precedent.** Polarsteps — a travel-journal app whose users wanted their journals printed — runs on Peecho's Print API, and says photo books now account for all of the revenue the feature generates. Their co-founder on the integration: *"We only added the Peecho checkout to our website and app, and then implemented a couple of push notifications to let users know they can order a travel book... That's the only thing we did."* That is the same feature we are building, described by somebody who already built it.

**What it costs us in obligations:**

- **A warranty we have to be able to make.** Their terms require the client to hold *"all rights, titles and interest including, without limitation, any intellectual property rights"* and *"portrait rights"* in what is printed, and to indemnify them. A book of letters somebody else wrote, containing photographs of other people's children, needs a matching line in pdayletters.com's own terms before this ships. This is a real piece of work, not a formality.
- **Files are kept.** *"PEECHO reserves the right to maintain files in storage for the purpose of creating reprints."* So the PDF cannot be handed over behind a fifteen-minute SAS URL and forgotten about; the gating has to survive their fetching it again later.
- **Non-competition for two years** after the term, covering their printers. Irrelevant unless we ever wanted to go direct, which we do not.
- **Liability capped at EUR 10,000**, Dutch law, Amsterdam courts. Fine at this scale.

**Still unknown, and needs a free account to answer:**

- Which trim sizes are actually offered. Our 8×10 came out of Lulu's catalogue and may not survive.
- Whether hardcover requires a page count that is a multiple of four. The interior already pads to an even count so every letter opens on a left-hand page; a multiple-of-four rule extends that arithmetic.
- Payout currency, almost certainly euros.
- Bleed and safe-area figures for the cover spread, which the cover generator needs before it can be written.

They have a designated test environment, and their terms are explicit that orders not meant to be printed must not go to production.

### Blurb Bookstore — the fallback

Category A, and the terms read well: *"Keep 100% of profits when you sell your book in our bookstore"*, no listing fees, Blurb handles printing, global shipping and fulfilment, and you set your own price. Photo books, hardcover, softcover, magazines.

Rejected as first choice on automation, not economics. There is no public order API worth building against today, so creating the listing is a manual step in a browser — which puts a human between the owner pressing the button and the book existing. Their other routes, Amazon and Ingram, add distribution fees and make the book public.

Worth keeping in mind precisely because the economics are good. If Peecho's trim sizes or margins turn out wrong, this is where we go.

### Lulu — rejected, and it used to be the recommendation

Lulu has the best public API in this market by some distance: fully documented, free, sandbox included, thousands of product configurations, hardcover photo books in many trims. Everything the old plan said about it is true.

It is Category B, and that is fatal. The print job payload requires a full shipping address — name, street, city, region, country, postcode, phone — plus a contact email. That is the reader's PII flowing through our Function. And on payment, Lulu Direct's own documentation is unambiguous: *"When they purchase, Lulu will automatically charge the payment method you've saved with us to pay for printing and shipping"*, and *"Lulu will handle printing and shipping the book to your customer while you pay Lulu for printing and shipping costs."* We would be the merchant. Lulu markets "Retain Customer Data" as a feature; we want the exact opposite.

Lulu Bookstore inverts it correctly — Lulu takes the payment, the author keeps 80%, publishing is free and no ISBN is needed — but it is a public storefront, and these books cannot be listed publicly.

There is no affiliate programme. The help article that would describe one returns 404.

### Cloudprinter.com — rejected

Category B. A capable wholesale network — REST API, PHP and Node SDKs, 381 print locations across 104 countries, photobook and textbook products. We would pay them and bill the reader ourselves, which is the same wall Lulu hits.

### Gelato, Prodigi, BookVault — rejected

Category B, all of them, for the same reason. Not assessed in detail because the shape settles it. (Prodigi is worth a footnote: it now owns Peecho, so the recommended provider is a Prodigi company reached through the one product line that sells to the buyer instead of to us.)

### Shutterfly — rejected, twice

Rejected once during planning and again here, so it is written down properly this time.

There is no API. `developers.shutterfly.com` returns HTTP 410 Gone; the Commerce API is invitation-only for strategic retail partners and is not open to individual developers. The only route is Category C: an affiliate link through Rakuten Advertising, roughly 5% commission on a fifteen-day cookie, subject to an approval process a private site with no public content is unlikely to pass. The owner's experience would be downloading a zip of photographs and rebuilding the entire book by hand in Shutterfly's builder — throwing away the layout engine, the chapter openings, the contents page and the mirrored gutter.

An owner who genuinely wants Shutterfly can already do this: the archive export gives them every photograph.

### Mixbook, Snapfish — rejected

Category C, and the same argument as Shutterfly with worse commissions.

### Amazon KDP — rejected

No photo-book product, and the print API is not open to individual accounts. Built for trade paperbacks. Amazon Associates covers retail links only.

## Where this leaves us

Build against **Peecho**: Print API for the upload, hosted checkout for the sale. Cover the file-format questions with a free account before the cover generator is written, since the trim size and the bleed feed straight into it.

Keep **Blurb Bookstore** as the fallback if the trim sizes do not work out, and accept the manual listing step if it comes to that.

Nothing here commits the layout engine to a provider. The interior it produces is an ordinary PDF at 300 dpi with a mirrored gutter; the only provider-shaped decisions in it are the page size and the parity rule, and both are constants at the top of `functions/src/lib/book.js`.
