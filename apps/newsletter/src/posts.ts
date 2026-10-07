export interface Post { slug: string; title: string; summary: string; paragraphs: string[] }

export const POSTS: Post[] = [
  {
    slug: 'reading-without-an-account',
    title: 'Reading without an account',
    summary: 'Why this newsletter never asks who you are.',
    paragraphs: [
      'Most subscriptions start with an email address and end with a profile: what you read, when, and from where. This letter starts with a payment and ends there.',
      'You paid in shielded ZEC. In return, your browser holds a handful of tokens that we signed without seeing them. When you open a reading session, you spend one. We can check that the token is genuine and unused, but we cannot tell which payment bought it.',
      'There is no account to delete, because none was created.',
    ],
  },
  {
    slug: 'what-we-can-still-see',
    title: 'What we can still see',
    summary: 'An honest list of what leaks, and to whom.',
    paragraphs: [
      'At payment time we learn that a claim code paid a fixed amount at a certain time. When a token is spent we learn that some subscriber for this month opened a session. We learn how many subscribers there are.',
      'We do not learn your address, your wallet, or which payment matches which visit. Your network address is another matter: unless you use Tor Browser or a VPN, the same IP address at payment and at reading can link the two.',
      'With only a few subscribers, timing can also link payment and use. That is why your pass waits a few random minutes before its first use.',
    ],
  },
  {
    slug: 'renewal-is-a-fresh-payment',
    title: 'Renewal is a fresh payment',
    summary: 'Zcash has no pull payments, and that is a feature.',
    paragraphs: [
      'Card subscriptions renew because the merchant can pull money from your account. Zcash cannot do that: every payment is one you send.',
      'So when your tokens run low, you buy a new pass. Nothing is charged behind your back, and nothing links this month’s pass to the last one.',
    ],
  },
];
