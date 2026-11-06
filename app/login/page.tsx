import { safeNext } from "@/lib/auth";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function Login({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const next = safeNext(Array.isArray(sp.next) ? sp.next[0] : sp.next);
  return (
    <section className="login">
      <h1>Sign in</h1>
      <form method="post" action="/api/login">
        <input type="hidden" name="next" value={next} />
        {/* A username field lets password managers save and fill the login. */}
        <input type="text" name="username" autoComplete="username" defaultValue="forex-ai" hidden readOnly />
        <label>
          Password
          <input type="password" name="password" autoComplete="current-password" autoFocus required />
        </label>
        {sp.error && <p className="warn">Wrong password.</p>}
        <button type="submit">Sign in</button>
      </form>
      <p className="note">You stay signed in on this device for a year.</p>
    </section>
  );
}
