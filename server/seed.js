"use strict";

const { connect, close, state, slugify, readMinutes } = require("./db");
const auth = require("./auth");

const PROJECTS = [
  { slug: "kettle", title: "Kettle", domain: "sw", year: 2026, state: "Active",
    headline: "The build cache that had to learn what a step actually touches",
    dek: "An incremental build cache for monorepos that reasons about effects, not just file hashes.",
    metric: "4.2×", metricKey: "Cold-build speedup", plate: "kettle",
    spec: [["Language", "Rust"], ["Tests", "1,204"], ["Stars", "2.1k"]],
    bodyMd: "The first version was a content-addressed cache and it was wrong about a third of the time. Not wrong in a way that failed loudly — wrong in the way that produces a binary that works on the machine that built it and nowhere else.\n\nHashing inputs is a claim about determinism. A build step that reads the clock, or the environment, or a file it never declared, is not a function of its declared inputs, and no amount of hashing those inputs will tell you so.\n\n## The effect log\n\nEvery step runs under a syscall filter that records what it actually touched. The recorded set is compared against the declared set; a mismatch invalidates the entry and reports the undeclared read by path.\n\n```\n$ kettle explain build/parser\n  declared   src/parser/**.rs   42 files\n  observed   /etc/localtime      1 file   <- undeclared\n  verdict    NOT CACHEABLE\n```" },

  { slug: "sidereal", title: "Sidereal", domain: "hw", year: 2025, state: "Active",
    headline: "Closing the loop on a mount that would not stop flexing",
    dek: "A closed-loop equatorial mount for astrophotography, corrected against a live plate-solve.",
    metric: "0.8″", metricKey: "Tracking RMS", plate: "sidereal",
    spec: [["Process", "CNC 6061"], ["Mass", "3.4 kg"], ["Revision", "C"]],
    bodyMd: "Open-loop tracking is a bet that nothing in the mechanism flexes. On a bench, at room temperature, with no wind, that bet mostly pays. Pointed at the sky for four hours in November it does not.\n\nThe correction path is a plate-solve every ninety seconds: capture, solve against the astrometric index, compute the true pointing error, and fold it into the rate rather than jumping the axis. Jumping shows up in the exposure; a rate correction does not.\n\n## What actually fixed it\n\nGetting from six arcseconds to sub-arcsecond was mostly mechanical, not algorithmic. Backlash in the worm was the dominant term, and no control loop fixes backlash — it only hides it until the direction reverses." },

  { slug: "cardinal", title: "Cardinal", domain: "ml", year: 2025, state: "Shipped",
    headline: "Eighty-seven species, four hundred milliwatts, one microcontroller",
    dek: "On-device bird-call classification running inside a 400 mW power budget in the field.",
    metric: "0.91", metricKey: "F1 across 87 species", plate: "cardinal",
    spec: [["Parameters", "1.2 M"], ["Training data", "94 h"], ["Latency", "31 ms"]],
    bodyMd: "The model is small because the power budget is 400 mW and the device sits on a hillside with a one-watt panel and no one to visit it. Everything downstream of that constraint is a consequence of it.\n\nAggregate F1 was the wrong thing to optimise for a long time. The held-out set was dominated by common species, so the metric was largely reporting how well the model did on birds anyone can identify by ear.\n\n> Reweighting the evaluation by how much a mistake would actually cost an ecologist changed which checkpoint we shipped." },

  { slug: "tracewright", title: "Tracewright", domain: "sw", year: 2025, state: "Shipped",
    headline: "Telling two CI runs apart when both of them passed",
    dek: "A differ for distributed traces: point it at two CI runs and it tells you what actually changed.",
    metric: "1.1 M/s", metricKey: "Spans ingested", plate: "tracewright",
    spec: [["Language", "Go"], ["Tests", "663"], ["Stars", "840"]],
    bodyMd: "Two green builds can differ enormously in what they did. Tracewright aligns spans across runs by structural position rather than by name, so a renamed step still matches, and reports the diff as a waterfall." },

  { slug: "loam", title: "Loam", domain: "hw", year: 2024, state: "Fielded",
    headline: "Seven months on a hillside without a single visit",
    dek: "A solar soil-moisture mesh that has been reporting from a hillside for seven months unattended.",
    metric: "214 d", metricKey: "Unattended uptime", plate: "loam",
    spec: [["Process", "PCB rev D"], ["Mass", "96 g"], ["Radio", "LoRa 868"]],
    bodyMd: "Ten milliwatts is a design constraint, not a number you measure at the end. Once the budget is fixed first, the radio duty cycle, the sample rate and the choice of sensor all stop being independent decisions." },

  { slug: "understory", title: "Understory", domain: "ml", year: 2024, state: "Paper",
    headline: "Measuring canopy height from orbit, then checking it with a plane",
    dek: "Canopy-height regression from Sentinel-2, validated against airborne LiDAR across three biomes.",
    metric: "2.4 m", metricKey: "RMSE against LiDAR", plate: "understory",
    spec: [["Parameters", "18 M"], ["Dataset", "41 GB"], ["R²", "0.87"]],
    bodyMd: "Validation is the whole paper. Anyone can regress a number out of a satellite image; the question is whether it survives contact with an independent instrument over terrain it was not trained on." },

  { slug: "hookshot", title: "Hookshot", domain: "hw", year: 2023, state: "Archived",
    headline: "Every motor in the base and nothing heavy past the shoulder",
    dek: "A cable-driven four-DOF arm with all its motors in the base and nothing heavy past the shoulder.",
    metric: "1.4 kg", metricKey: "Payload at full reach", plate: "hookshot",
    spec: [["Process", "3D print"], ["Mass", "1.1 kg"], ["Revision", "B"]],
    bodyMd: "Cable drive moves the mass problem rather than solving it: the arm gets light and the routing gets hard. Tension coupling between joints was the term that took longest to model." },

  { slug: "marginalia", title: "Marginalia", domain: "sw", year: 2023, state: "Shipped",
    headline: "Annotating PDFs without shipping a PDF engine",
    dek: "An annotation layer for PDFs that renders in the browser without shipping a PDF engine.",
    metric: "38 kB", metricKey: "Gzipped bundle", plate: "marginalia",
    spec: [["Language", "TypeScript"], ["Tests", "417"], ["Stars", "1.3k"]],
    bodyMd: "The trick is that annotations do not need the document — they need a stable coordinate space and a way to anchor to text that survives reflow." }
];

const POSTS = [
  { slug: "build-cache-knows", title: "What a build cache can and cannot know",
    dek: "Content hashing is a claim about determinism, and most build steps quietly aren’t.",
    projectSlug: "kettle", publishedAt: "2026-06-14T09:00:00.000Z" },
  { slug: "closing-the-loop", title: "Closing the loop on a star tracker",
    dek: "Open-loop tracking is a bet that nothing flexes. Something always flexes.",
    projectSlug: "sidereal", publishedAt: "2025-11-03T09:00:00.000Z" },
  { slug: "ten-milliwatts", title: "Ten milliwatts is a design constraint, not a number",
    dek: "What changes when the power budget stops being something you measure at the end.",
    projectSlug: "loam", publishedAt: "2025-04-19T09:00:00.000Z" },
  { slug: "against-confusion", title: "Against the confusion matrix",
    dek: "Aggregate metrics hide exactly the failures that matter in a deployed classifier.",
    projectSlug: "cardinal", publishedAt: "2025-02-08T09:00:00.000Z" },
  { slug: "svg-by-hand", title: "Writing SVG by hand, on purpose",
    dek: "A short argument for drawing your own diagrams, with the path syntax you actually need.",
    projectSlug: "marginalia", publishedAt: "2024-09-21T09:00:00.000Z" },
  { slug: "a-drawing-is-a-claim", title: "A drawing is a claim",
    dek: "Engineering drawings are not illustrations. They are assertions with tolerances.",
    projectSlug: "understory", publishedAt: "2024-03-12T09:00:00.000Z" }
];

const BODY = `There is a particular kind of bug that only appears once the thing leaves the bench. It is not a logic error and it does not reproduce in a test, because the condition it depends on is a property of the world rather than of the program.

What follows is an account of one of those, and of the measurement that eventually made it visible. The short version is that the assumption was never written down anywhere, which is exactly why it survived three rewrites.

## The assumption

Every system has a boundary it treats as trustworthy. Inside that boundary things are assumed stable: the clock is monotonic, the mechanism is rigid, the labels are correct. The boundary is rarely stated, which means it is rarely checked.

> A specification that does not say what it assumes is not a specification. It is a description of one run.

The fix in each case has the same shape — make the assumption an observable, then let it fail loudly. That is more work than it sounds, because most assumptions are not directly measurable and have to be inferred from something adjacent.

## What I would do differently

Write the assumption down first, in the same file as the code that depends on it, in a form a test can read. Everything else here is a consequence of not having done that.`;

/**
 * Idempotent. Creates the admin user if there are none, and seeds sample
 * content only into empty collections — so restarting the container never
 * duplicates or overwrites real posts.
 */
async function seedIfEmpty() {
  const result = { user: null, content: false, posts: 0, projects: 0 };

  if ((await state.users.countDocuments()) === 0) {
    const username = process.env.ADMIN_USER || "admin";
    const password = process.env.ADMIN_PASSWORD;
    if (!password || password.length < 12) {
      console.error(
        "\n  FATAL: no admin user exists and ADMIN_PASSWORD is unset or under 12 characters.\n" +
        "  Set ADMIN_USER and ADMIN_PASSWORD, then start again.\n"
      );
      process.exit(1);
    }
    await state.users.insertOne({
      username,
      passwordHash: await auth.hash(password),
      sessionEpoch: 0, // bumped to invalidate all outstanding session cookies
      createdAt: new Date().toISOString()
    });
    result.user = username;
  }

  if ((await state.projects.countDocuments()) === 0) {
    const now = new Date().toISOString();
    await state.projects.insertMany(PROJECTS.map((p, i) => ({
      ...p,
      slug: p.slug || slugify(p.title),
      cover: null,
      status: "published",
      sort: i,
      createdAt: now,
      updatedAt: now
    })));
    result.projects = PROJECTS.length;
    result.content = true;
  }

  if ((await state.posts.countDocuments()) === 0) {
    const now = new Date().toISOString();
    await state.posts.insertMany(POSTS.map(p => ({
      slug: p.slug,
      title: p.title,
      dek: p.dek,
      bodyMd: `${p.dek}\n\n${BODY}`,
      category: "Essay",
      cover: null,
      projectSlug: p.projectSlug,
      readMinutes: readMinutes(BODY),
      status: "published",
      createdAt: p.publishedAt,
      updatedAt: now,
      publishedAt: p.publishedAt
    })));
    result.posts = POSTS.length;
    result.content = true;
  }

  return result;
}

module.exports = { seedIfEmpty };

// Allow `npm run seed` as a standalone command.
if (require.main === module) {
  (async () => {
    await connect();
    const r = await seedIfEmpty();
    console.log(r.content || r.user ? "Seeded:" : "Nothing to do — collections already populated.", r);
    await close();
  })().catch(err => { console.error(err); process.exit(1); });
}
