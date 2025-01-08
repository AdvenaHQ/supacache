# supacache
Supacache is a secure, lightweight, high-performance caching middleware for [`supabase-js`](https://github.com/supabase/supabase-js), built on [Cloudflare Workers](https://workers.cloudflare.com/) and [D1](https://www.cloudflare.com/en-au/developer-platform/products/d1/). 

## 👏 Key Features

- **Encrypted Cache**: All cached data is securely encrypted using AES-GCM for data protection.
- **Compression**: Combines [JSON](https://www.npmjs.com/package/compress-json) and [GZIP](https://www.npmjs.com/package/pako) compression and binary storage for instant stash and retrieval.
- **Real-Time Endpoint Bypass**: Automatically bypasses caching for real-time and subscribed endpoints.
- **Configurable, per-request TTLs**: Customize the cache expiration time using the `Cache-Control` header, or by passing a TTL in seconds via the `x-ttl` header.
- **High Performance**: Optimized for speed and reliability, ensuring minimal latency for cached and non-cached responses.
- **Extensibility**: Easily extend or modify the worker to fit your specific use case.
- **Highly Cost Effective**: Reduces Supabase egress bandwidth costs and leverages [generous D1 limits](https://developers.cloudflare.com/d1/platform/pricing/) to keep costs low. Easily operable for $0/month.
- **Hides your Supabase URL**: Works by proxying requests via [highly-configurable domains/routes](https://developers.cloudflare.com/workers/configuration/routing/). _⚠️ This is not a security feature. [See our note below.](#url-obscurity)_

---

## ⚡ Usage
Install, set up, and deploy your middleware by following the instructions below.

Once you're up and running, all you need to do is configure your [Supabase JS client](https://supabase.com/docs/reference/javascript/initializing) to use your Worker URL instead of your Supabase URL.

By default, the middleware enforces rudimentary authorisation to provide some protection against cache replaying, so you'll need to pass a custom fetcher to your Supabase instance on setup:

```typescript
import { createClient } from '@supabase/supabase-js'

const useSupabase = async (cacheTTLSeconds?: number) => createClient(
    "https://supacache.my-cloudflare-domain.workers.dev",
    "your-supabase-public-anon-key",
    {
        global: {
            fetch: (input, init?: RequestInit) => {
                return fetch(input, {
                    ...init,
                    headers: {
                        ...init?.headers,
                        "X-Cache-Service-Key": "my-secret-key", // This is the SERVICE_AUTH_KEY secret you created in Step 4 of the Middlware (Worker) setup
                        "X-TTL": cacheTTLSeconds?.toString() || "900", // 900 seconds = 15 minutes
                    },
                });
            },
        },
    },
);

...

const supabase = await useSupabase(30); // Creates a Supabase client which will cache eligible queries for 30 seconds

const { data, error } = await supabase
  .from('countries')
  .select();

...
```

### 🚩 Type-Safe Supabase SSR Wrapper for Next.js apps
For enhanced type-safety and extensibility in **Next.js** Typescript apps, you can use this initialiser hook that we created. This comes from our private Supabase utility package, which is an extremely powerful, type-safe extender for the Supabase client, which we use in our production apps. We're in the process of open-sourcing the entire package, but for now, here's a modified implementation for this project:

```typescript
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { GenericSchema } from "@supabase/supabase-js/dist/module/lib/types";
import { cookies } from "next/headers";

/**
 * Creates and returns a Supabase client configured for server-side usage with custom cookie handling and caching.
 *
 * @template Database - The type of the database schema.
 * @template SchemaName - The name of the schema within the database.
 * @template Schema - The schema definition.
 *
 * @param {number} [cacheTTLSeconds] - The time-to-live (TTL) for the cache in seconds. Defaults to 900 seconds (15 minutes) if not provided.
 *
 * @returns {Promise<SupabaseClient>} A promise that resolves to a configured Supabase client.
 */
export async function useSupabase<
    Database = any,
    SchemaName extends string & keyof Database = "public" extends keyof Database
        ? "public"
        : string & keyof Database,
    Schema extends GenericSchema = Database[SchemaName] extends GenericSchema
        ? Database[SchemaName]
        : any,
>(cacheTTLSeconds?: number): Promise<SupabaseClient> {
    // Get the cookies from the request headers
    const cookieStore = await cookies();

    // @ts-expect-error - This is a type error in the `@supabase/ssr` package. We are passing the correct options.
    return createServerClient<Database, SchemaName, Schema>(
        "https://supacache.my-cloudflare-domain.workers.dev",
        "your-supabase-public-anon-key",
        {
            cookies: {
                /**
                 * Retrieves all cookies from the cookie store.
                 */
                getAll() {
                    // Return all cookies from the cookie store when not using the service role
                    return cookieStore.getAll();
                },

                /**
                 * Sets multiple cookies using the provided array of cookie objects.
                 */
                // biome-ignore lint/suspicious/noExplicitAny: This is necessary to set cookies
                setAll(cookiesToSet: any) {
                    try {
                        for (const { name, value, options } of cookiesToSet) {
                            cookieStore.set(name, value, options);
                        }
                    } catch (error) {
                        // The `setAll` method was called from a Server Component. This can be ignored if you have middleware refreshing user sessions.
                    }
                },
            },
            global: {
                // Use the Supacache Worker to cache requests to the Supabase API
                fetch: (input, init?: RequestInit) => {
                    return fetch(input, {
                        ...init,
                        headers: {
                            ...init?.headers,
                            // Set the cache service key and TTL headers
                            "X-Cache-Service-Key": "my-secret-key",          // This is the SERVICE_AUTH_KEY secret you created in Step 4 of the Middlware (Worker) setup
                            "X-TTL": cacheTTLSeconds?.toString() || "900",   // 900 seconds = 15 minutes
                        },
                    });
                },
            },
        },
    );
}

// Export the Supabase client hook as the default export
export default useSupabase;
```

It can be used as such, optionally using your [generated schema types](https://supabase.com/docs/reference/javascript/typescript-support#generating-typescript-types):

```typescript
import { useSupabase } from "../path/to/useSupabase";
import type { Database, Tables } from "../path/to/database.types"; // see: https://supabase.com/docs/reference/javascript/typescript-support#generating-typescript-types

...

const supabase = await useSupabase<Database>(30); // Creates a Supabase server client which will cache eligible queries for 30 seconds

const { data, error } = await supabase
  .from('countries')
  .select()
  .returns<Tables<"countries">>();

...
```
---

The below setup and installation guides assume that you are familiar with Cloudflare Workers, Supabase, git, and some other topics of general awareness.

## 📦 Installation

Clone [or download this repository](https://github.com/AdvenaHQ/supacache/archive/refs/heads/main.zip):
```bash
git clone https://github.com/AdvenaHQ/supacache.git
cd supacache
```

## ⚙️ Setup

### Database setup
> [!TIP]
> Make sure to [provide a location hint](https://developers.cloudflare.com/d1/configuration/data-location/#provide-a-location-hint) geographically closest to your Supabase project's infrastructure. You can find this [in the Supabase dashboard](https://supabase.com/dashboard/project/_/settings/infrastructure).

1. [Create a Cloudflare D1 database](https://developers.cloudflare.com/d1/get-started/#2-create-a-database) via the dashboard or Wrangler CLI.
2. Create your cached responses table by executing the following query [via the Wrangler CLI](https://developers.cloudflare.com/d1/get-started/#4-run-a-query-against-your-d1-database) or Dashboard console:
```sql
CREATE TABLE supacache ( 
    key TEXT PRIMARY KEY,
    body BLOB NOT NULL,
    status INTEGER NOT NULL,
    headers TEXT NOT NULL,
    expires DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE INDEX idx_supacache_expires ON advena (supacache);
```

### Middleware (Worker) setup
Ensure you are inside the project directory when completing the middleware (Worker) setup. If you configured your D1 Database using the dashboard, you will need to [install the Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) for the next steps.

1. `wrangler.toml`:
Populate the following items in your `[vars]` definition:
- `SUPABASE_URL` - This is your Supabase Project URL (retrieve it from https://supabase.com/dashboard/project/_/settings/api)
- `D1_CACHESTORE_TABLE_NAME` - This is the name of your cache table in your D1 Database. If you used the above query in Step 2 of the database setup, this will be `supacache`.

Populate the following items in your `[[d1_databases]]` definition:
- `binding` - Don't change this value. It must be **"SUPACACHE_DB"**.
- `database_name` - This is the name you gave to your D1 Database when you created it in Step 1 of the Database setup.
- `database_id` - This is the ID of your D1 Database that was generated when you created it in Step 1.

Example configuration:
```toml
# ...

[vars]
SUPABASE_URL = "https://djrwqopbrhnycewwjhoire.supabase.co"
D1_CACHESTORE_TABLE_NAME = "supacache"

[[d1_databases]]
binding = "SUPACACHE_DB"
database_name = "my-d1-database" # 
database_id = "2872f4f3-e9c9-4aa5-97a7-2ca6f530409f"

# ...
```

2. (Optional) If you've never used the Wrangler CLI before, you will need to dry-run Wrangler to trigger Cloudflare authentication. This will bind your Wrangler CLI to your Cloudflare account to enable seamless serverless worker deployments. Inside your project directory, run:
```bash
npx wrangler dev
```
After signing into Cloudflare, shut down the created local server by pressing the `x` key in your terminal.

3. Next, we need to deploy the worker to Cloudflare's Edge network. Run the Wrangler deploy command:
```bash
wrangler deploy
```
The CLI will walk you through creating your worker on Cloudflare.

4. Currently, your worker will not work if you try to call it. First, we need to create some important secrets that we will push to the worker you just created. Using `openssl` (or [an online password generator](https://1password.com/password-generator)), create two secrets:
- One alphanumeric string, **exactly 32 characters long**, with no spaces or special characters. This will be our `D1_CACHESTORE_ENCRYPTION_KEY` secret, used for encrypting and decrypting cached data in the database.
- One alphanumeric string of any length between 64 and 256 characters long, with no spaces or special characters. This will be our `SERVICE_AUTH_KEY`, used to authenticate requests from your Supabase client instances.

5. Push these secret values into your worker using the Wrangler CLI by running the following commands separately. You will be prompted for the secret value after hitting "Enter":
```bash
wrangler secret push D1_CACHESTORE_ENCRYPTION_KEY
```
```bash
wrangler secret push SERVICE_AUTH_KEY
```

6. Generate your worker's types by running the following command:
```
wrangler types
```

7. Finally, publish your changes to the worker by running the deploy command again:
```bash
wrangler deploy
```

That's it! You're ready to use your worker. 🥳

----

## 🔒 Security
This middlware is secure by default when configured correctly. Proxied traffic is secured with TLS, and cached traffic is encrypted at rest and authenticated at retrieval.

There are loads of resources online. Be proactive, don't think you know everything, and assume there's always a vulnerability you're unaware of.

Never trust, but where you must, trust but verify.

### URL Obscurity
By nature of it's function, this solution obscures your Supabase API URL. [This must not be relied upon as a security feature](https://en.wikipedia.org/wiki/Security_through_obscurity) - it is not a legitimate remedy for preventing abuse, it is simply a consequential benefit of the Workers platform.

There is no substitution for good security hygiene, guidance-driven hardening, and purpose-built security features like Row Level Security (RLS). There's no shortage of solid, reputable guidance on securing your stack, whether that be [Supabase](https://supabase.com/docs/guides/database/secure-data), [Cloudflare Workers](https://developers.cloudflare.com/workers/reference/security-model/), or any other of the many tools driving your application.

## 🗺️ Planned Features
- [ ] [JSON Web Tokens](https://jwt.io/) (JWT) for client authentication, instead of `X-Cache-Service-Key` header
- [ ] Implement End-to-End Encryption (E2EE) and request authentication for enhanced data security
- [ ] Implement automatic pre-fetching and cache warming for common/popular queries
- [ ] Implement automated, durable background eviction of stale cache records
- [ ] Enable usage of single worker for multiple Supabase instances
- [ ] Implement Stale-While-Revalidate and optimistic returns functionality

## 🧸 Contributing
Contributions are welcome! Please open an issue or submit a pull request for any improvements or bug fixes.

## ⚖️ License
This project is licensed under the MIT License. See the LICENSE file for details.
