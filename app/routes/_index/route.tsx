import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Grüns post-purchase offers</h1>
        <p className={styles.text}>
          Relevant cross-sells selected from the contents of each completed
          checkout.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Context-aware offers.</strong> Match complementary products
            to the customer&apos;s order.
          </li>
          <li>
            <strong>Native checkout.</strong> Present the offer through
            Shopify&apos;s post-purchase extension.
          </li>
          <li>
            <strong>Measurable results.</strong> Track offer conversion and
            incremental revenue.
          </li>
        </ul>
      </div>
    </div>
  );
}
