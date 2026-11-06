 Can you send a button that asks the user for free-text input?

  No — not natively on consumer WhatsApp via Baileys.

  When a user taps a quick_reply button, the client sends back the hidden id immediately. There is no input field, no
  prompt, no "ask the user to type something" widget. The same is true for cta_url (just opens a link), cta_call (just
  dials), cta_copy (just copies). None of them carry an input box.

  Three things look similar but aren't quite what you described:

  ┌──────────────────────────────────┬─────────────────────────────────────────────┬───────────────────────────────┐
  │             Feature              │            What it actually does            │     Available via Baileys     │
  ├──────────────────────────────────┼─────────────────────────────────────────────┼───────────────────────────────┤
  │                                  │ Opens a full form inside WhatsApp — text    │ ❌ Only on the official Cloud │
  │ WhatsApp Flows (Meta Cloud API)  │ fields, selects, date pickers, multi-step   │  Business API. Not on         │
  │                                  │ screens. This is what you're describing.    │ consumer WA (Baileys).        │
  ├──────────────────────────────────┼─────────────────────────────────────────────┼───────────────────────────────┤
  │ requestPhoneNumberMessage        │ One-tap "Share your phone number" prompt    │ ✅ Baileys supports it. Not   │
  │                                  │                                             │ exposed in Evolution.         │
  ├──────────────────────────────────┼─────────────────────────────────────────────┼───────────────────────────────┤
  │ address_message / send_location  │                                             │ ✅ Baileys can send these as  │
  │ native_flow buttons              │ One-tap "Share address" / "Share location"  │ native_flow buttons. Not      │
  │                                  │                                             │ exposed in Evolution.         │
  └──────────────────────────────────┴─────────────────────────────────────────────┴───────────────────────────────┘

  The pattern everyone actually uses for "button → ask for more details":

  1. Send your buttons message with quick_reply IDs like help_repair, help_refund, help_billing.
  2. Listen for MESSAGES_UPSERT webhooks.
  3. When you see interactiveResponseMessage or templateButtonReplyMessage with selectedId = help_repair, send a
  follow-up text: "Sure — describe the issue and I'll route it to support."
  4. The next plain text message from that JID is the "extra detail".

  This is a two-turn conversation, not a one-shot form, but it's what every WhatsApp bot does (and what Cloud API Flows
  replaces for business accounts).

  What Baileys offers that Evolution-API doesn't expose

  Audited against the public methods in whatsapp.baileys.service.ts. Ordered roughly by "how often you'll miss it":

  Messaging — missing from /message/*:

  ┌─────────────────────┬─────────────────────────────────────────────┬────────────────────────────────────────────┐
  │       Feature       │                 Baileys API                 │                  Use case                  │
  ├─────────────────────┼─────────────────────────────────────────────┼────────────────────────────────────────────┤
  │ Forward a message   │ { forward: WAMessage, force? } in           │ Forward any prior message by key — there's │
  │                     │ AnyMessageContent                           │  no /message/forward endpoint today.       │
  ├─────────────────────┼─────────────────────────────────────────────┼────────────────────────────────────────────┤
  │ Pin / unpin in chat │ { pin: WAMessageKey, type, time: 86400 |    │ Pin a message for 24h/7d/30d. Common in    │
  │                     │ 604800 | 2592000 }                          │ support inboxes.                           │
  ├─────────────────────┼─────────────────────────────────────────────┼────────────────────────────────────────────┤
  │ Request phone       │ proto.Message.requestPhoneNumberMessage     │ One-tap share-your-number prompt — perfect │
  │ number              │                                             │  for KYC / lead capture.                   │
  ├─────────────────────┼─────────────────────────────────────────────┼────────────────────────────────────────────┤
  │ Address / location  │ native_flow address_message, send_location  │ One-tap "Share your address/location" —    │
  │ request buttons     │                                             │ way better UX than asking in text.         │
  ├─────────────────────┼─────────────────────────────────────────────┼────────────────────────────────────────────┤
  │ Event message       │ { event: EventMessageOptions }              │ Send a calendar-style event card.          │
  │ (calendar invite)   │                                             │                                            │
  ├─────────────────────┼─────────────────────────────────────────────┼────────────────────────────────────────────┤
  │ Pin message         │                                             │                                            │
  │ reactions / poll    │ pollResultSnapshotMessage                   │ Push a result-snapshot of a poll.          │
  │ snapshots           │                                             │                                            │
  ├─────────────────────┼─────────────────────────────────────────────┼────────────────────────────────────────────┤
  │ Disappearing        │ { disappearingMessagesInChat: number }      │ Set 24h/7d/90d ephemeral mode on a chat.   │
  │ messages toggle     │                                             │                                            │
  ├─────────────────────┼─────────────────────────────────────────────┼────────────────────────────────────────────┤
  │ Product / Catalog   │ { product: WASendableProduct,               │ Send a product card from your business     │
  │ message             │ businessOwnerJid? }                         │ catalog.                                   │
  ├─────────────────────┼─────────────────────────────────────────────┼────────────────────────────────────────────┤
  │                     │                                             │ When a customer builds an order from your  │
  │ Order message       │ orderMessage (read side)                    │ catalog, you receive an order message —    │
  │                     │                                             │ Evolution doesn't currently surface it.    │
  ├─────────────────────┼─────────────────────────────────────────────┼────────────────────────────────────────────┤
  │ Multi-product (mpm) │ native_flow mpm                             │ Multi-product picker (different from your  │
  │  carousel           │                                             │ generic carousel).                         │
  ├─────────────────────┼─────────────────────────────────────────────┼────────────────────────────────────────────┤
  │ Review-and-pay /    │                                             │ E-commerce checkout flow on WhatsApp Pay   │
  │ review-order        │ native_flow review_and_pay, review_order    │ markets (BR especially).                   │
  │ buttons             │                                             │                                            │
  ├─────────────────────┼─────────────────────────────────────────────┼────────────────────────────────────────────┤
  │ Reminders           │ native_flow cta_reminder /                  │ "Remind me in 1h" tappable buttons.        │
  │                     │ cta_cancel_reminder                         │                                            │
  ├─────────────────────┼─────────────────────────────────────────────┼────────────────────────────────────────────┤
  │ Sticker pack        │ stickerPackMessage                          │ Send a whole sticker pack vs. one sticker. │
  │ message             │                                             │                                            │
  ├─────────────────────┼─────────────────────────────────────────────┼────────────────────────────────────────────┤
  │ Album message       │ albumMessage                                │ Photo album as a single message.           │
  ├─────────────────────┼─────────────────────────────────────────────┼────────────────────────────────────────────┤
  │ Limit sharing       │ { limitSharing: boolean }                   │ Restrict forwarding for sensitive          │
  │                     │                                             │ messages.                                  │
  └─────────────────────┴─────────────────────────────────────────────┴────────────────────────────────────────────┘

  Newsletters / Channels — entire feature missing:

  The Baileys socket exposes newsletterCreate, newsletterFollow, newsletterUnfollow, newsletterUpdateName,
  newsletterUpdateDescription, newsletterUpdatePicture, newsletterMetadata, newsletterAdminInvite,
  newsletterReactMessage, newsletterMuteUpdate. Evolution recognizes newsletter JIDs in handlers but has zero CRUD
  endpoints — so creating/managing a WhatsApp channel via Evolution isn't possible today.

  Groups — partial gaps:

  ┌───────────────────────────────────────┬─────────────────────────────────────────────────────────────────────────┐
  │                Feature                │                                Use case                                 │
  ├───────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────┤
  │ groupRequestParticipantsList / Update │ Approve/reject pending join requests (admins). Evolution has            │
  │                                       │ add/remove/promote but not the join-request queue.                      │
  ├───────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────┤
  │ groupToggleEphemeral                  │ Set disappearing-messages duration on a group.                          │
  ├───────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────┤
  │ groupFetchAllParticipating with full  │ You have fetchAllGroups but the participant cache control flags aren't  │
  │ metadata                              │ exposed.                                                                │
  ├───────────────────────────────────────┼─────────────────────────────────────────────────────────────────────────┤
  │ groupAcceptInviteV4                   │ Accept the V4 invite payload (with key). Evolution accepts the legacy   │
  │                                       │ inviteCode only.                                                        │
  └───────────────────────────────────────┴─────────────────────────────────────────────────────────────────────────┘

  Business profile — partial:

  You already have updateProfileName, updateProfileStatus, updateProfilePicture. Baileys also exposes the full business
  profile (description, email, websites[], address, category/vertical, business hours) — none of those fields are
  updatable through Evolution today, only readable via fetchBusinessProfile.

  Misc:

  - stickerCreate (generate animated WebP from an MP4/GIF) — Evolution sends pre-made stickers but doesn't build them.
  - fetchMessageHistory (request older history from a participant) — you have MESSAGING_HISTORY_SET event but no
  explicit fetch trigger.
  - Privacy: online, groupsAdd, callAdd — Evolution has updatePrivacySettings but not all sub-settings.

  My recommendation

  If you want the biggest UX upgrade for the least effort, in this order:

  1. Forward message (/message/forward/:instance) — ~30 lines, huge win.
  2. Pin in chat (/chat/pin/:instance) — ~20 lines.
  3. requestPhoneNumber + address_message interactive buttons — extend the existing buttonMessage switch with two new
  types (type: "phone_request", type: "address_request"). This is the closest thing to your "actionable extra context"
  idea — the user taps once, you get structured data back.
  4. Newsletter CRUD — biggest feature gap, but ~5-8 new endpoints needed.
  5. Disappearing messages toggle — 1 endpoint.
  6. Business profile full update — extend the existing profile endpoint with the extra fields.

  Want me to implement any of these? I'd suggest starting with #1 + #2 + #3 in one PR since they're all small, then
  newsletter in a follow-up since it's its own surface area.