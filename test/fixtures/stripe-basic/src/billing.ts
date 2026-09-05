import Stripe from "stripe";

// The client is deliberately NOT named "stripe" — detection must come from
// the type checker, not the variable name.
const billing = new Stripe(process.env.STRIPE_KEY!, { apiVersion: "2024-06-20" });

export async function defaultPaymentMethod(customerId: string) {
  const customer = await billing.customers.retrieve(customerId);
  if (customer.deleted) return null;
  return customer.invoice_settings.default_payment_method;
}

export async function startSubscription(customerId: string, price: string) {
  const { id, status, current_period_end } = await billing.subscriptions.create({
    customer: customerId,
    items: [{ price }],
    metadata: { plan: "pro" },
  });
  return { id, status, renewsAt: current_period_end };
}

export async function latestInvoiceTotal(customerId: string) {
  return (await billing.invoices.list({ customer: customerId, limit: 1 })).data[0]?.total;
}

// Result escapes into another function: operation is certain, fields are not.
export async function refund(chargeId: string) {
  const r = await billing.refunds.create({ charge: chargeId });
  audit(r);
}
function audit(_: unknown) {}

export function handleWebhook(payload: Buffer, signature: string) {
  const event = billing.webhooks.constructEvent(payload, signature, process.env.STRIPE_WEBHOOK_SECRET!);
  switch (event.type) {
    case "invoice.payment_failed": {
      const invoice = event.data.object;
      return { code: invoice.last_payment_error?.code, customer: invoice.customer };
    }
    case "customer.subscription.deleted":
      return event.data.object.id;
    case "checkout.session.completed":
      // Passed elsewhere: lower bound only.
      return fulfil(event.data.object);
  }
}
function fulfil(_: unknown) {}
