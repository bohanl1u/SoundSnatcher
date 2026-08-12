/* SoundSnatcher landing page.
 *
 * The page is static and always available. The live demo section is hidden by
 * default and only appears if a running instance answers its health check —
 * so when the machine hosting it is asleep, visitors simply get a complete
 * landing page and never see a broken embed. */

// ---------------------------------------------------------------- config

/* Public hostname of the live instance, e.g. a Tailscale Funnel or Cloudflare
 * Tunnel address. Must be https:// — this page is served over TLS, so a plain
 * http:// origin would be blocked as mixed content. Leave empty to disable the
 * remote demo entirely. */
const DEMO_ORIGIN = '';

/* Probed separately so anyone who already installed it gets sent to their own
 * copy. http://localhost counts as a trustworthy origin, though Safari has been
 * inconsistent about allowing it from an https page — treat it as a bonus. */
const LOCAL_ORIGIN = 'http://localhost:4747';

const PROBE_TIMEOUT_MS = 2500;

// ----------------------------------------------------------------- probe

/** Resolves true only if the instance answers its health check in time. */
async function isUp(origin) {
  if (!origin) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${origin}/api/health`, {
      signal: ctrl.signal,
      cache: 'no-store',
      mode: 'cors',
    });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.ok === true;
  } catch {
    // Asleep, offline, tunnel down, CORS refused, or DNS gone. All the same
    // outcome from here: don't show the demo.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function initDemo() {
  const [remoteUp, localUp] = await Promise.all([
    isUp(DEMO_ORIGIN),
    isUp(LOCAL_ORIGIN),
  ]);

  // A local install always beats the shared demo: it's theirs, and it has no
  // rate limits.
  if (localUp) {
    const section = document.getElementById('local');
    const link = document.getElementById('local-link');
    if (link) link.href = LOCAL_ORIGIN;
    if (section) section.hidden = false;
    return;
  }

  if (remoteUp) {
    const section = document.getElementById('demo');
    const frame = document.getElementById('demo-iframe');
    if (frame) frame.src = DEMO_ORIGIN;
    if (section) section.hidden = false;
  }
}

// -------------------------------------------------------------- niceties

/** Copy buttons on the install snippets. */
function initCopy() {
  for (const btn of document.querySelectorAll('.copy')) {
    btn.addEventListener('click', async () => {
      const code = btn.parentElement?.querySelector('code');
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code.textContent.trim());
        const original = btn.textContent;
        btn.textContent = 'Copied';
        btn.classList.add('done');
        setTimeout(() => {
          btn.textContent = original;
          btn.classList.remove('done');
        }, 1600);
      } catch {
        btn.textContent = 'Press ⌘C';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1600);
      }
    });
  }
}

/**
 * Fade sections in as they enter the viewport.
 *
 * The hiding is applied by script, never in the markup — an opacity:0 class in
 * the HTML would leave the page permanently blank for anyone whose JavaScript
 * fails to run. Content is visible by default and only then opted into animating.
 */
function initReveal() {
  const targets = document.querySelectorAll('.showcase, .feature, .stat, .steps li');
  if (!targets.length) return;

  if (!('IntersectionObserver' in window)) return; // leave everything visible

  for (const t of targets) t.classList.add('reveal');

  const show = (el) => el.classList.add('in');

  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry, i) => {
      if (!entry.isIntersecting) return;
      // Slight stagger so a row of cards arrives in sequence rather than as a block.
      setTimeout(() => show(entry.target), i * 70);
      io.unobserve(entry.target);
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });

  for (const t of targets) io.observe(t);

  // Backstop: whatever the observer hasn't reported on by now gets shown anyway,
  // so a throttled or background tab can never strand content at opacity 0.
  setTimeout(() => targets.forEach(show), 3000);
}

/** Hairline under the nav once the page has scrolled. */
function initNav() {
  const nav = document.querySelector('.nav');
  if (!nav) return;
  const onScroll = () => nav.classList.toggle('stuck', window.scrollY > 8);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
}

initNav();
initCopy();
initReveal();
initDemo();
