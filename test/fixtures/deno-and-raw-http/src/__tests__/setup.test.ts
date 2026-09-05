// Test files are excluded by default. Nothing in here may appear in the manifest.
import Stripe from "stripe";
const stripe = new Stripe("sk_test_x");
export async function t() {
  const c = await stripe.customers.create({ email: "t@example.com" });
  return c.id;
}
