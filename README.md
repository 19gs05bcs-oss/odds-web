# Web app (Next.js)

## Setup

1. Copy `.env.example` → `.env.local` and fill Supabase + Dodo Payments keys.
2. Run SQL: `../supabase/memberships.sql` in Supabase SQL editor (see migration below for the lemon→dodo column rename).
3. Supabase Auth → URL configuration:
   - Site URL: `http://localhost:3001` (or production domain)
   - Redirect URLs: `http://localhost:3001/auth/callback`
4. Dodo Payments → Developer → Webhooks → Add endpoint:
   - URL: `https://your-domain.com/api/webhooks/dodo-payments`
   - Secret: same as `DODO_PAYMENTS_WEBHOOK_KEY`
   - Events: `subscription.active`, `subscription.renewed`, `subscription.updated`, `subscription.on_hold`, `subscription.cancelled`, `subscription.expired`, `subscription.failed`

## Membership flow

- Public: `/`, `#demo`, `#pricing`, `/login`
- Sign in via magic link → `/account`
- Subscribe → Dodo Payments checkout → webhook updates `profiles`
- Members: `/analyze`, `/seasons`, `/matches` + data APIs

```bash
npm install
npm run dev -- -p 3001
```
