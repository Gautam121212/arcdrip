// Patterns seen in real Next.js / Express route handlers that the first
// scanner version missed. Each one is a regression test.
import Stripe from "stripe";

const stripe = new Stripe(process.env.KEY!, { apiVersion: null as any });

// 1. Params built in a variable, then reassigned with spreads.
export async function checkout(customer: string, priceId: string, recurring: boolean) {
  let params: Stripe.Checkout.SessionCreateParams = {
    customer,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: "https://x/ok",
  };
  if (recurring) {
    params = { ...params, mode: "subscription", subscription_data: { trial_period_days: 7 } };
  } else {
    params = { ...params, mode: "payment" };
  }
  // 2. Result assigned to a variable declared earlier, inside try/catch.
  let session;
  try {
    session = await stripe.checkout.sessions.create(params);
  } catch (err) {
    throw new Error("failed");
  }
  if (session) return { sessionId: session.id };
  throw new Error("failed");
}

// 3. Params as a const object; truthiness check on the result is not a leak.
export async function createCustomer(uuid: string, email: string) {
  const customerData = { metadata: { appUserId: uuid }, email };
  const created = await stripe.customers.create(customerData);
  if (!created) throw new Error("no customer");
  return created.id;
}

// 4. Fire-and-forget statement: nothing is read, and that is complete.
export async function updateBilling(customer: string, name: string) {
  await stripe.customers.update(customer, { name });
}

// 5. Destructured result of an operation that was missing from the table.
export async function portal(customer: string) {
  const { url } = await stripe.billingPortal.sessions.create({ customer, return_url: "https://x/account" });
  return url;
}

// 6. Webhook bound by assignment, fall-through cases, `as` casts, aliases.
export async function webhook(body: string, sig: string) {
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.WH!);
  } catch {
    return 400;
  }
  switch (event.type) {
    case "product.created":
    case "product.updated":
      await upsert(event.data.object as Stripe.Product);
      break;
    case "customer.subscription.created":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      await track(sub.id, sub.customer as string, event.type === "customer.subscription.created");
      break;
    }
    case "checkout.session.completed": {
      const cs = event.data.object as Stripe.Checkout.Session;
      if (cs.mode === "subscription") await track(cs.subscription as string, cs.customer as string, true);
      break;
    }
  }
  return 200;
}
async function upsert(_: unknown) {}
async function track(_a: string, _b: string, _c: boolean) {}
