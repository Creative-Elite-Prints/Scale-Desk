# ScaleDesk server

One small server that does two jobs:

1. **Live jobs:** collects open jobs and pushes new ones to your ScaleDesk page.
2. **Project rooms:** private rooms where a client and a developer share messages and files. A room stays open until the client approves the work **and** the full payment is recorded, then it closes.

Needs Node.js 18 or newer. No packages to install.

## Put it online (step by step)

You need a free GitHub account and a Render account (render.com). Other hosts that run Node also work.

1. On GitHub, create a new **private** repository and upload everything in this folder (keep the `public` folder).
2. On Render, choose **New**, then **Blueprint**, and pick that repository. Render reads `render.yaml` and creates the service with a disk and three generated passwords. If you set it up by hand instead, use start command `node server.js`, add a persistent disk mounted at `/var/data`, and add the settings below.
3. Open the service's **Environment** page and copy the values of `ACCESS_KEY` and `ADMIN_KEY`. Keep them private.
4. Open `https://YOUR-ADDRESS/api/health`. You should see `"ok": true`.
5. Open `https://YOUR-ADDRESS/admin`, sign in with your `ADMIN_KEY`, and create a test room.
6. In ScaleDesk, go to Find jobs, enter your server address and `ACCESS_KEY`, and press **Connect**.

Use an always-on plan. Free plans sleep, which stops the job feed and loses room files.

## Settings (environment variables)

| Name | What it does |
| --- | --- |
| `ACCESS_KEY` | Password for the job feed. |
| `ADMIN_KEY` | Your owner password for project rooms. Rooms are off until you set it. |
| `PAYMENT_WEBHOOK_SECRET` | Optional. Lets a payment tool confirm payments automatically (see below). |
| `DATA_DIR` | Where rooms and files are saved. Must be on a persistent disk. |
| `ROOM_DAYS` | How long a room may stay open if never finished. Default 60. |
| `DOWNLOAD_DAYS_AFTER_CLOSE` | Days the client can still download files after a room closes. Default 7, then files are deleted. |
| `ALLOWED_ORIGIN` | The address of your ScaleDesk page, once hosted. |
| `SOURCES` | Job sources, for example `freelancer,remoteok`. |
| `FREELANCER_TOKEN` | Optional Freelancer.com API token. |

## How a project room works

1. You create a room in `/admin` (title, client name, price, optional payment link). You get a **client link** and a **developer link**, shown once. Send each to the right person.
2. Both people can chat and upload files. The developer can mark a file **Final delivery**.
3. The client can download previews at any time. **Final files stay locked until the full price is recorded as paid.**
4. When the client presses **Approve** and the full payment is recorded, the room closes: no more messages or uploads. The client can download files for a few more days, then everything is deleted.
5. If nobody finishes, the room closes by itself after `ROOM_DAYS`. You can reopen it, add days, close it, replace a link, or delete the files from `/admin`.

## Recording payments

- **By hand:** in `/admin`, press **Record payment** and enter the amount you received.
- **Automatically:** set `PAYMENT_WEBHOOK_SECRET`, then have your payment tool send `POST /api/webhooks/payment` with a JSON body like `{"roomId":"abc123","amount":500,"reference":"unique-payment-id"}` and a header `x-signature` containing the HMAC-SHA256 of the raw body (in hex) using that secret. Repeated references are ignored, so retries are safe. Each payment provider needs a small adapter to send this. Choose your provider first and it can be added.

## Security notes

- Links and passwords are stored only as hashes. Wrong keys are rate limited, and repeated failures block that address for 10 minutes.
- Uploaded files are never opened in the browser, only downloaded.
- Share room links only with the client and developer. Anyone holding a link can enter that room until it closes.
- This is **not** escrow. The client pays you directly, and the developer is protected because final files unlock only after full payment is recorded. Paying your developers is separate.
- Rooms are saved in a single file on the disk, so run one copy of the server and back up `DATA_DIR`.
- The rules were tested with an automated check, but the code has not had an independent security review. Get one before handling large payments or sensitive files.

## Live jobs

| Source | How often | Notes |
| --- | --- | --- |
| Freelancer.com | every 60 seconds | Searches active projects for website, wordpress, game, mobile app, web app, chatbot. |
| RemoteOK | every 15 minutes | Credit and link back to RemoteOK (the page does this). |
| Remotive | every 6 hours | **Off by default.** Limited to 4 fetches a day, 24 hour delay, credit and link back required, and no passing jobs to other job boards. |

If Freelancer jobs stop appearing, check Freelancer's developer documentation for changes. Bids and messages for these jobs go through each site itself, using the **Open original** button. Read each source's current terms before using the feed publicly.

## Try it on your computer

Run `node server.js`, then visit `http://localhost:3000/api/health`. To test rooms, start it with `ADMIN_KEY=choose-a-password node server.js` and open `http://localhost:3000/admin`.
