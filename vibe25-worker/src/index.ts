import { Context, Hono } from "hono";
import { cors } from "hono/cors";

// Add Cloudflare Workers types
interface D1Database {
  prepare(query: string): any;
}

// Add global types for Cloudflare Workers
declare global {
  // eslint-disable-next-line no-var
  var fetch: any;
  // eslint-disable-next-line no-var
  var console: {
    log: (...args: any[]) => void;
    error: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    info: (...args: any[]) => void;
  };
}

type Bindings = {
  DB: D1Database;
  NGROK_API_KEY: string;
};

type Variables = {};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Apply CORS middleware globally
app.use("*", corsMiddleware);

app.use("*", async (c, next) => {
  await next();
});

async function corsMiddleware(c: any, next: any) {
  const allowedOrigins = [
    "http://localhost:5173",
    "https://www.nerdnarcan.com",
  ];
  const origin = c.req.header("Origin");
  const corsHeaders = {
    "Access-Control-Allow-Origin": allowedOrigins.includes(origin)
      ? origin
      : allowedOrigins[0],
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Authorization, User-ID, Content-Type, Api-Key",
    "Access-Control-Max-Age": "86400",
  };

  // Apply CORS headers to all responses
  Object.entries(corsHeaders).forEach(([key, value]) => {
    c.res.headers.set(key, value);
  });

  // If this is an OPTIONS request, return 204 immediately
  if (c.req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  // Otherwise continue to the actual handler
  await next();
}

async function validateAdminRequest(c: Context, next: any) {
  // Skip validation for OPTIONS requests
  if (c.req.method === "OPTIONS") {
    return await next();
  }

  const apiKey = c.req.header("Api-Key");
  if (apiKey !== c.env.ADMIN_API_KEY) {
    return c.text("Unauthorized", 403);
  }

  await next();
}

app.use("*", corsMiddleware);
app.get("/test", async (c) => {
  return c.text("Hello, world!");
});

app.get("/", async (c) => {
  return c.text("Hello, world!");
});

app.post("/heartbeat", async (c) => {
  try {
    const {
      user_id,
      url,
      cpu_cores,
      cpu_load,
      ram_total,
      ram_used,
      disk_free,
      status,
    } = await c.req.json();

    // Validate required fields
    if (
      !user_id ||
      !url ||
      !cpu_cores ||
      !cpu_load ||
      !ram_total ||
      !ram_used ||
      !disk_free ||
      !status
    ) {
      return c.json({ error: "Missing required fields" }, 400);
    }

    const now = new Date().toISOString();

    // Check if device exists for this user_id
    const existingDevice = await c.env.DB.prepare(
      "SELECT id FROM devices WHERE user_id = ?"
    )
      .bind(user_id)
      .first();

    if (existingDevice) {
      // Update existing device

      const id =
        Date.now().toString() + Math.random().toString(36).substring(2);

      await c.env.DB.prepare(
        `
        UPDATE devices 
        SET id = ?, url = ?, cpu_cores = ?, cpu_load = ?, ram_total = ?, 
            ram_used = ?, disk_free = ?, status = ?, last_seen = ?
        WHERE user_id = ?
      `
      )
        .bind(
          id,
          url,
          cpu_cores,
          cpu_load,
          ram_total,
          ram_used,
          disk_free,
          status,
          now,
          user_id
        )
        .run();
    } else {
      // Insert new device
      const id =
        Date.now().toString() + Math.random().toString(36).substring(2);
      await c.env.DB.prepare(
        `
        INSERT INTO devices (
          id, user_id, url, cpu_cores, cpu_load, ram_total, 
          ram_used, disk_free, status, last_seen
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
        .bind(
          id,
          user_id,
          url,
          cpu_cores,
          cpu_load,
          ram_total,
          ram_used,
          disk_free,
          status,
          now
        )
        .run();
    }

    return c.json({ success: true });
  } catch (error) {
    console.error("Heartbeat error:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

app.get("/devices", async (c) => {
  try {
    const activeDevices = await c.env.DB.prepare(
      `SELECT url, cpu_cores, cpu_load, ram_total, ram_used, disk_free, user_id 
       FROM devices 
       WHERE status = 'ACTIVE'`
    ).all();

    return c.json(activeDevices.results);
  } catch (error) {
    console.error("Error fetching active devices:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

app.get("/jobs/:user_id", async (c) => {
  try {
    const user_id = c.req.param("user_id");

    const jobs = await c.env.DB.prepare(
      `SELECT id, filename, lang, status, stdoutt, stderr 
       FROM jobs 
       WHERE requester = ?`
    )
      .bind(user_id)
      .all();

    return c.json(jobs.results);
  } catch (error) {
    console.error("Error fetching jobs:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

app.get("/check-for-jobs/:user_id", async (c) => {
  try {
    const user_id = c.req.param("user_id");

    const queuedJob = await c.env.DB.prepare(
      `SELECT id, lang, code, filename 
       FROM jobs 
       WHERE device_id = ? AND status = 'QUEUED'
       LIMIT 1`
    )
      .bind(user_id)
      .first();

    if (!queuedJob) {
      return c.json({ job: null });
    }

    // Update the job status to RUNNING
    await c.env.DB.prepare(`UPDATE jobs SET status = 'RUNNING' WHERE id = ?`)
      .bind(queuedJob.id)
      .run();

    return c.json({ job: queuedJob });
  } catch (error) {
    console.error("Error checking for jobs:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

app.post("/submit-job", async (c) => {
  try {
    const { requester, device_id, filename, lang, code, cost_usd } =
      await c.req.json();

    // Validate required fields
    if (
      !requester ||
      !device_id ||
      !filename ||
      !lang ||
      !code ||
      cost_usd === undefined
    ) {
      return c.json({ error: "Missing required fields" }, 400);
    }

    // Validate language is either python or javascript
    if (lang !== "python" && lang !== "javascript") {
      return c.json(
        { error: "Language must be either 'python' or 'javascript'" },
        400
      );
    }

    // Generate a unique ID for the job
    const id = Date.now().toString() + Math.random().toString(36).substring(2);

    // Insert the new job into the database
    await c.env.DB.prepare(
      `
      INSERT INTO jobs (
        id, requester, device_id, filename, lang, code, 
        status, cost_usd, stdoutt, stderr
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    )
      .bind(
        id,
        requester,
        device_id,
        filename,
        lang,
        code,
        "QUEUED",
        cost_usd,
        "",
        ""
      )
      .run();

    // Update the device status to BUSY
    await c.env.DB.prepare(
      `UPDATE devices SET status = 'BUSY' WHERE user_id = ?`
    )
      .bind(device_id)
      .run();

    // Add entry to ledger
    const ledgerId =
      Date.now().toString() + Math.random().toString(36).substring(2);

    // Validate and convert cost_usd
    if (typeof cost_usd !== "number" || isNaN(cost_usd)) {
      console.error("Invalid cost_usd:", cost_usd);
      return c.json({ error: "Invalid cost_usd value" }, 400);
    }

    // Convert USD to cents, handling sub-cent amounts
    const amountCents =
      cost_usd < 0.01
        ? Math.round(cost_usd * 10000) / 100 // For amounts less than 1 cent, multiply by 10000 first
        : Math.round(cost_usd * 100); // For normal amounts, multiply by 100

    console.log("Cost conversion:", { cost_usd, amountCents });

    const epochTimestamp = Math.floor(Date.now() / 1000).toString();

    await c.env.DB.prepare(
      `
      INSERT INTO ledger (
        id, job_id, from_user, to_user, amount_cents, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      `
    )
      .bind(ledgerId, id, requester, device_id, amountCents, epochTimestamp)
      .run();

    // Update budgets for both users
    // Check if sender exists in budgets, if not create initial entry
    const senderBudget = await c.env.DB.prepare(
      `SELECT spent_cents FROM budgets WHERE user_id = ?`
    )
      .bind(requester)
      .first();

    if (!senderBudget) {
      await c.env.DB.prepare(
        `INSERT INTO budgets (user_id, spent_cents, earned_cents) VALUES (?, 0, 0)`
      )
        .bind(requester)
        .run();
    }

    // Update sender's spent_cents
    await c.env.DB.prepare(
      `UPDATE budgets SET spent_cents = ? WHERE user_id = ?`
    )
      .bind((senderBudget?.spent_cents || 0) - amountCents, requester)
      .run();

    // Check if receiver exists in budgets, if not create initial entry
    const receiverBudget = await c.env.DB.prepare(
      `SELECT earned_cents FROM budgets WHERE user_id = ?`
    )
      .bind(device_id)
      .first();

    if (!receiverBudget) {
      await c.env.DB.prepare(
        `INSERT INTO budgets (user_id, spent_cents, earned_cents) VALUES (?, 0, 1000)`
      )
        .bind(device_id)
        .run();
    }

    // Update receiver's earned_cents
    await c.env.DB.prepare(
      `UPDATE budgets SET earned_cents = ? WHERE user_id = ?`
    )
      .bind((receiverBudget?.earned_cents || 1000) + amountCents, device_id)
      .run();

    return c.json({
      success: true,
      job_id: id,
    });
  } catch (error) {
    console.error("Job submission error:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

app.post("/update-job", async (c) => {
  try {
    const { job_id, stdout, stderr } = await c.req.json();

    // Validate required fields
    if (!job_id) {
      return c.json({ error: "Missing job_id" }, 400);
    }

    // Update the job in the database
    await c.env.DB.prepare(
      `UPDATE jobs 
       SET stdoutt = ?, stderr = ?, status = 'FINISHED' 
       WHERE id = ?`
    )
      .bind(stdout || "", stderr || "", job_id)
      .run();

    // Update the device status back to ACTIVE
    await c.env.DB.prepare(
      `UPDATE devices 
       SET status = 'ACTIVE' 
       WHERE user_id = (
         SELECT device_id 
         FROM jobs 
         WHERE id = ?
       )`
    )
      .bind(job_id)
      .run();

    return c.json({ success: true });
  } catch (error) {
    console.error("Error updating job:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

app.post("/get-ngrok-access", async (c) => {
  try {
    const { user_id } = await c.req.json();

    if (!user_id) {
      return c.json({ error: "Missing user_id" }, 400);
    }

    // Call ngrok API to create tunnel credential
    const response = await fetch("https://api.ngrok.com/credentials", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${c.env.NGROK_API_KEY}`,
        "Ngrok-Version": "2",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        description: "desktop-client",
        metadata: `user_id:${user_id}`,
        acl: ["bind:*"],
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error("Ngrok API error:", errorData);
      return c.json(
        { error: "Failed to generate ngrok token" },
        response.status
      );
    }

    const data = await response.json();

    // Return just the token and id to the client
    return c.json({
      token: data.token,
      id: data.id,
    });
  } catch (error) {
    console.error("Error getting ngrok access:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

app.get("/get-budget/:user_id", async (c) => {
  try {
    const user_id = c.req.param("user_id");

    // Get the user's budget information
    const budget = await c.env.DB.prepare(
      `SELECT spent_cents, earned_cents FROM budgets WHERE user_id = ?`
    )
      .bind(user_id)
      .first();

    // If user doesn't exist in budgets, return default values
    if (!budget) {
      return c.json({
        spent_cents: 0,
        earned_cents: 1000, // $10 initial balance
      });
    }

    return c.json(budget);
  } catch (error) {
    console.error("Error getting budget:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

export default app;
