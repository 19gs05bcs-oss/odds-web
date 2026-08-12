# Web app (Next.js)

## Setup

1. Copy `.env.example` → `.env.local` and fill Supabase + Lemon Squeezy keys.
2. Run SQL: `../supabase/memberships.sql` in Supabase SQL editor.
3. Supabase Auth → URL configuration:
   - Site URL: `http://localhost:3001` (or production domain)
   - Redirect URLs: `http://localhost:3001/auth/callback`
4. Lemon Squeezy → Settings → Webhooks:
   - URL: `https://your-domain.com/api/webhooks/lemon-squeezy`
   - Secret: same as `LEMONSQUEEZY_WEBHOOK_SECRET`
   - Events: `subscription_created`, `subscription_updated`, `subscription_cancelled`, `subscription_expired`, `subscription_payment_success`, `subscription_payment_failed`

## Membership flow

- Public: `/`, `#demo`, `#pricing`, `/login`
- Sign in via magic link → `/account`
- Subscribe → Lemon Squeezy checkout → webhook updates `profiles`
- Members: `/analyze`, `/seasons`, `/matches` + data APIs

```bash
npm install
npm run dev -- -p 3001
```
