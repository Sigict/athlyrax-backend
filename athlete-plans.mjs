// Athlete App plans (register item 27): PLANNED PRICES ONLY. No Stripe product or price exists for
// them, there is no checkout, and nothing here changes what any athlete or parent can use today:
// while a plan is not on sale, the Athlete App stays included exactly as it is now. The owner sees
// these plans in the Owner Console as "planned, not on sale". Selling them needs an owner decision
// (billing interval, what each plan includes) and Stripe products created by the owner.
export const ATHLETE_PLAN_RULES = Object.freeze({
  athlete: Object.freeze({ label: 'Athlete', amountMinor: 499, currency: 'gbp', covers: 'One athlete' }),
  'athlete-parent': Object.freeze({ label: 'Athlete + Parent', amountMinor: 899, currency: 'gbp', covers: 'One athlete and their parent or guardian' }),
});

export const ATHLETE_PLANS_STATUS = 'planned';

export function athletePlanCatalogue(rules = ATHLETE_PLAN_RULES) {
  return Object.entries(rules).map(([key, r]) => ({
    key, product: r.label, covers: r.covers, expectedMinor: r.amountMinor, currency: r.currency,
    status: ATHLETE_PLANS_STATUS, onSale: false, interval: 'not decided', stripeProduct: null,
    note: 'Planned price only: no Stripe product, no checkout; current Athlete App access is unchanged.',
  }));
}

// What an athlete or parent account may use. While no athlete plan is on sale, access is the
// current free access for everyone, whatever plan key a record might carry.
export function athleteEntitlement() {
  return { access: 'included', paidPlan: null, reason: 'Athlete plans are planned but not on sale; the Athlete App remains included.' };
}
