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

**What their specification actually says, now that there is an account to read it from:**

- **Trim sizes.** Hardcovers come in A5 either way up, A4 either way up, US Letter portrait (216 × 280 mm, 8.5 × 11 in), 11 × 8.5 in landscape, and two squares at 8.3 in and 11.6 in. That is the whole list. The 8 × 10 this book was first laid out to is not on it and never was — it came out of Lulu's catalogue, which is what comes of choosing a trim before choosing a printer. **Letter portrait** is the only portrait shape on the list an American reader would recognise, so that is what the interior is set to now.
- **One PDF, covers included.** *"Save your print file as one PDF document containing front cover, content, and back cover, as single pages and in this order."* This deletes a whole task: there is no separate cover spread to generate, and no wraparound geometry to get right. The spine is Peecho's — they calculate it from the page count, the paper and whichever facility ends up printing it.
- **Page count: 24 to 500, and even.** *"If you submit an odd number of pages, the back cover will be white."* Not a multiple of four, so the parity the interior already keeps is enough — but the floor of 24 is new, and a mission with three letters in it does not reach it. The interior pads up to it with blank leaves.
- **No bleed, no crop marks.** *"Do not add bleed or cut marks, as our system will automatically generate these."* The opposite of the assumption a printer usually forces.
- **10 mm minimum margin** on every side of both cover and content. Ours is an inch at the narrowest, so there is nothing to do here.
- **300 dpi, RGB, all fonts embedded, transparencies flattened.** RGB is worth noting: they do their own separation, which means a press profile chosen per facility rather than one guessed here. PDF/X-4 against coated FOGRA 39 is their preference.
- **Page two lands on the right.** *"This is page two of your PDF, and it will appear on the right-hand side."* Pages two and three of the physical object are the binding sheets and cannot be printed on. So with the cover as PDF page one, interior leaf one is a recto and the mirrored margins fall the way they already do.
- **Payout.** USD is among the supported currencies. Threshold is EUR 100 before a withdrawal can be made.

**The one distinction in the API that decides the architecture.** There are two ways to get a book made, and they are not variants of each other:

- **A product listing-publication** returns an id, and `peecho.com/print/{id}` is a checkout page for it. The buyer pays Peecho; Peecho pays us the margin. This is Category A, and it is our path.
- **Create order plus order payment** runs on prepaid credits bought from the dashboard — `MERCH_INSUFFICIENT_BALANCE` is a real error code. That is the wholesale shape: we would be taking the money and the card fraud and the refunds. Not our path, and worth writing down because the endpoint names make it look like the obvious one.

Authentication is a Merchant API key on most endpoints, with a separate secret key used to SHA-256 sign the things that matter. Webhooks post JSON with a `signature` that is `sha256(secretKey + order_id)`, which is the same shape as the HMAC the invite links already use. The test environment is a genuinely separate account at `test.www.peecho.com` with its own key; orders placed there never print and never charge.

**Still blocked, but their own help centre says it should not be.** Their company-details form requires a VAT number, and without it the API returns `APP_NO_COMP_DETAILS` — *"Company details are required for tax calculations"* — and the webhook settings will not save either. A US sole trader has no VAT number and the field is VIES-validated, so inventing one is not an option.

The help centre contradicts the form. [What is a VAT number? Is it mandatory?](https://support.peecho.com/hc/en-us/articles/360011846520-What-is-a-VAT-number-Is-it-mandatory) answers, verbatim: *"If you do not have a registered VAT business or if you are in a country where no VAT applies, then you can leave this field blank."* The caveat worth stating plainly is that the article is filed under **Getting paid**, so it may be describing the withdrawal profile's VAT field rather than the application's company details — the two are different forms and only one of them blocks the API. Either way it is the sentence to open a ticket with, because it is their answer to exactly this question.

Nothing else has been written about this anywhere. The error code `APP_NO_COMP_DETAILS` returns **zero** search results outside their own documentation; there is no Peecho developer forum, no community board, and nothing on Stack Overflow. So there is no workaround to find — the ticket is the whole path.

The support channel is the form at [support.peecho.com/hc/en-us/requests/new](https://support.peecho.com/hc/en-us/requests/new). The only email address they publish is `sales@peecho.com`, for demos and enterprise, and Peecho is now part of [Prodigi Group](https://www.prodigi.com/) — worth knowing if the ticket stalls.

### Blurb Bookstore — the fallback

Category A, and the terms read well: *"Keep 100% of profits when you sell your book in our bookstore"*, no listing fees, Blurb handles printing, global shipping and fulfilment, and you set your own price. Photo books, hardcover, softcover, magazines.

Rejected as first choice on automation, not economics. There is no public order API worth building against today, so creating the listing is a manual step in a browser — which puts a human between the owner pressing the button and the book existing. Their other routes, Amazon and Ingram, add distribution fees and make the book public.

Worth keeping in mind precisely because the economics are good. If Peecho's sizes or margins turn out wrong, this is where we go.

### Lulu — rejected, and it used to be the recommendation

Lulu has the best public API in this market by some distance: fully documented, free, sandbox included, thousands of product configurations, hardcover photo books in many trims. Everything the old plan said about it is true.

It is Category B, and that is fatal. The print job payload requires a full shipping address — name, street, city, region, country, postcode, phone — plus a contact email. That is the reader's PII flowing through our Function. And on payment, Lulu Direct's own documentation is unambiguous: *"When they purchase, Lulu will automatically charge the payment method you've saved with us to pay for printing and shipping"*, and *"Lulu will handle printing and shipping the book to your customer while you pay Lulu for printing and shipping costs."* We would be the merchant. Lulu markets "Retain Customer Data" as a feature; we want the exact opposite.

Lulu Bookstore inverts it correctly — Lulu takes the payment, the author keeps 80%, publishing is free and no ISBN is needed — but it is a public storefront, and these books cannot be listed publicly.

There is no affiliate programme. The help article that would describe one returns 404.

### Cloudprinter.com — rejected

Category B. A capable wholesale network — REST API, PHP and Node SDKs, 381 print locations across 104 countries, photobook and textbook products. We would pay them and bill the reader ourselves, which is the same wall Lulu hits.

### Gelato, Prodigi, BookVault — rejected

Category B, all of them, for the same reason. Not assessed in detail because the shape settles it. (Prodigi is worth a footnote: it now owns Peecho, so the recommended provider is a Prodigi company reached through the one product line that sells to the buyer instead of to us.)

### Printful, Printify, Gooten — rejected, and worth explaining why they keep coming up

These three are the names you land on when you search for a print-on-demand API, and they dominate the results so thoroughly that it is easy to assume one of them must be the answer. They are not, and they fail twice over, which is worth writing down so nobody searches again in six months and finds the same three.

They are merchandise fulfilment networks. Their business is putting a design on a blank someone else manufactured — a t-shirt, a mug, a phone case, a canvas — and shipping it for a merchant who has a shop somewhere. A bound book is not a blank with a design on it, and none of the three sells one.

**Printful.** The best API in this entire comparison, on the merits: REST, OAuth 2.0 with scoped tokens, an OpenAPI spec, a Postman collection, webhooks with a sane retry ladder, mockup generation, shipping-rate and tax endpoints, and error codes that tell you what you did wrong. It is also Category B in the plainest terms anyone in this document uses. Creating an order requires a `recipient` with name, address, city, country, postcode, phone and email; confirming one, in their own words, means *"Store owner's credit card is charged when the order is submitted for fulfillment"*, and cancelling means *"Charged amount is returned to the store owner's credit card."* We would be the merchant, holding the reader's address, on our card. And after all that there would still be nowhere to put the letters: the catalogue runs to t-shirts, posters, framed prints, postcards, canvases, mugs and hats. Nothing bound. US company, Charlotte, North Carolina, with fulfilment across the EU, UK, Canada, Australia and Japan. There is an affiliate programme but the page that would state its terms could not be reached, so no number is claimed here.

**Printify.** The same shape with a slightly different accent. A well-built REST API — v1 and a JSON:API v2, personal access tokens or OAuth 2.0, HMAC-signed webhooks, 600 requests a minute — over a network of independent print providers rather than its own factories. `address_to` is required on every order, the order lifecycle includes a `payment-not-received` status and the API returns 402 Payment Required, all of which describes a merchant who pays. The catalogue is organised as "blueprints": apparel, mugs, phone cases, stickers, canvas, jewellery. No books. Registered in the US with its engineering in Riga.

**Gooten.** Same shape again, and the weakest fit of the three. Five hundred-odd products across apparel, drinkware, wall art, blankets and mugs, none of them bound. The company has been pushing towards OrderMesh, an order-management product, and its front door is a sales enquiry form asking for average monthly order volume — which is a reasonable thing to ask an apparel brand and an unhelpful thing to ask a family site that might sell a handful of books a year. New York.

### Vistaprint — rejected

Unlike the three above, Vistaprint genuinely makes the product: hardcover photo books in seven sizes, 24 to 120 pages, two paper stocks, linen or photo covers, layflat on some sizes, starting around thirteen dollars. A Cimpress brand, with US operations and a long print history.

It is still Category C, and the worst version of it. There is no public print API — the only way a book gets made is a person sitting in Vistaprint's online editor or their downloadable desktop editor, choosing photographs and dropping them into layouts. There is no seam anywhere in that flow to hand a finished PDF to. So the owner would export the archive, upload every photograph again, and rebuild by hand a book this codebase already knows how to typeset, and we would earn a referral percentage on the chance they finished. The 120-page ceiling is its own problem: two years of letters and photographs will not fit.

### Shutterfly — rejected, twice

Rejected once during planning and again here, so it is written down properly this time.

There is no API. `developers.shutterfly.com` returns HTTP 410 Gone; the Commerce API is invitation-only for strategic retail partners and is not open to individual developers. The only route is Category C: an affiliate link through Rakuten Advertising, roughly 5% commission on a fifteen-day cookie, subject to an approval process a private site with no public content is unlikely to pass. The owner's experience would be downloading a zip of photographs and rebuilding the entire book by hand in Shutterfly's builder — throwing away the layout engine, the chapter openings, the contents page and the mirrored gutter.

An owner who genuinely wants Shutterfly can already do this: the archive export gives them every photograph.

### Mixbook, Snapfish — rejected

Category C, and the same argument as Shutterfly with worse commissions.

### Amazon KDP — rejected

No photo-book product, and the print API is not open to individual accounts. Built for trade paperbacks. Amazon Associates covers retail links only.

## All of it side by side

Shape is the column that is not here, because it is the one that decides everything: A is a hosted checkout where the buyer pays the printer, B is wholesale where we would pay and become the merchant, C is a bare referral link. Only Peecho and the two bookstores are A.

| Provider | US-based | Money back to us | API — quality and fit | Things to consider |
| --- | --- | --- | --- | --- |
| **Peecho** — recommended | No. Netherlands, Prodigi group | Margin over their cost; no fixed percentage, no cookie window, no approval | Purpose-built for this: Print API plus hosted checkout, test environment | Letter portrait, 24–500 even pages, no bleed, one PDF including covers. Their terms need a matching IP and portrait-rights warranty in ours, and the VAT field blocks the account today |
| **Blurb Bookstore** — fallback | Yes. San Francisco | "100% of profits" — our own markup over their cost | No usable order API; the listing is created by hand in a browser | Good economics, manual step. Amazon and Ingram routes make the book public |
| **Lulu Bookstore** | Yes. Raleigh | 80% royalty, free to publish, no ISBN needed | None for this route | Public storefront. Fatal for family letters |
| **Lulu Print API** | Yes. Raleigh | None. We would mark up and bill | Excellent — documented, free, sandboxed, thousands of configurations. Wrong shape | Payload demands the reader's full address and their card charges ours. Markets "Retain Customer Data" as a feature |
| **Cloudprinter.com** | No. Netherlands | None. Wholesale | Good REST API with SDKs, 381 print sites. Wrong shape | Has photobook products, which makes it the most tempting of the Category B set |
| **Gelato** | No. Norway | None. Wholesale | Not assessed; shape settles it | — |
| **Prodigi** | No. UK | None. Wholesale | Not assessed; shape settles it | Owns Peecho, so we reach it anyway through the one line that bills the buyer |
| **BookVault** | No. UK | None. Wholesale | Not assessed; shape settles it | — |
| **Printful** | Yes. Charlotte, NC | Affiliate programme exists; terms page unreachable, so no number claimed | Best API here — OAuth 2.0, OpenAPI, webhooks, mockups. Wrong shape and wrong catalogue | Docs say the store owner's card is charged on confirm. No bound book of any kind |
| **Printify** | Yes, registered; operations in Riga | None. Wholesale | Solid — v1 REST plus a JSON:API v2, signed webhooks. Wrong shape | `address_to` required, `payment-not-received` order status. Catalogue is apparel and mugs |
| **Gooten** | Yes. New York | None. Wholesale | Adequate; company is pivoting to OrderMesh | Front door is a sales enquiry form asking monthly order volume. No books |
| **Vistaprint** | Cimpress brand with US operations | Referral only, low single digits | None. Design happens in their own editor | Makes a real hardcover photo book, but capped at 120 pages and there is no seam to hand a PDF to |
| **Shutterfly** | Yes | ~5% via Rakuten, 15-day cookie, approval required | `developers.shutterfly.com` returns 410 Gone; Commerce API is invitation-only | Owner rebuilds the book by hand. Approval unlikely for a private site |
| **Mixbook** | Yes | Referral only, worse than Shutterfly | None | As Shutterfly |
| **Snapfish** | Yes | Referral only, worse than Shutterfly | None | As Shutterfly |
| **Amazon KDP** | Yes | Associates commission on retail links only | Not open to individual accounts | No photo-book product at all |

Two things fall out of reading down the columns. The API column is close to inverted: the best-engineered APIs in the market — Lulu's, Printful's — belong to the providers we cannot use, because a good wholesale API is still a wholesale API. And being US-based turns out to correlate with nothing we care about; the one provider that fits is Dutch.

## Where this leaves us

Build against **Peecho**: Print API for the upload, hosted checkout for the sale. The file-format questions are answered — the interior is set to Letter portrait, covers and all, and pads to their 24-page floor.

Keep **Blurb Bookstore** as the fallback if the account never clears, and accept the manual listing step if it comes to that.

Nothing here commits the layout engine to a provider. The interior it produces is an ordinary PDF at 300 dpi with a mirrored gutter; the only provider-shaped decisions in it are the page size and the page-count rules, and all of them are constants at the top of `functions/src/lib/book.js`.
