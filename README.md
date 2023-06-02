# Garmin inReach IPC Tracking Forwarder

Garmin's inReach devices and plans aren't great when it comes to easily tracking one inReach device with another inReach device in an automated way. In my case, I compete in long distance bicycle races through very remote areas with no cell coverage. During these races I may have a support person that needs to keep tabs on my location and progress, making it easier to coordinate hand-offs of supplies like food and water, batteries, lights, or other items.

Since these areas are so remote, the support person cannot rely on having any cell service to check my MapShare web page, which normally receives tracking updates from my inReach device (when enabled). The only reliable way to communicate and share my location with the support person is via another satellite communicator, ideally another inReach device.

Out of the box inReach devices support embedding location information when sending a message from one inReach device to another, but this process can't be automated, and is difficult to do on a regular basis when my main focus is racing and riding my bike.

inReach devices support tracking via sending out a location update automatically at a set interval, but these location updates can't be sent to another inReach device. Instead, they are routed to Garmin's gateway and shared on your MapShare page, which requires an internet connection to be viewed. In addition to that, visitors of your MapShare page can request your location (when enabled), but one inReach device cannot request the location of another inReach device.

To workaround all of this, I've created a simple serverless function that combines Garmin's [Outbound](https://developer.garmin.com/inReach/IPC_Outbound.pdf) and [Inbound](https://developer.garmin.com/inReach/IPC_Inbound.pdf) IPC (inReach Portal Connect) APIs to essentially forward location updates from one inReach device to another inReach device.

In a nutshell:

- The person that wants to be tracked turns on tracking on their inReach device
- Garmin forwards messages from the inReach device to the serverless function
- The serverless function validates the request and sends a message to the inReach device of the person that's doing the tracking with the location data included
- Essentially the location update from the device being tracked is forwarded to the device doing the tracking

## Setup

You'll need the following before getting started:

- A [Garmin Explore](https://explore.garmin.com/) account
- A [DigitalOcean](https://www.digitalocean.com/) account
- DigitalOcean's [doctl](https://docs.digitalocean.com/reference/doctl/) CLI installed on your computer
- Two Garmin inReach devices
- Optionally, a [Better Stack](https://betterstack.com/) account for logs

To get this to work, you'll need to be a on a professional inReach subscription plan, which will give you access to Garmin's IPC APIs. In addition to that, the inReach devices used need to be added and assigned to users within the professional subscription plan. Devices that aren't associated with your plan will not receive commands or messages sent via the APIs.

Clone or fork this repo, then open it locally on your computer. Create a new `.env` file, copy the contents from `.env.sample` into it, and fill out the required variables.

Afer that, deploy the function to DigitalOcean, and get its public URL.

```sh
./utils.sh deploy
./utils.sh get-url
```

From there, go into your account's [IPC settings page](https://explore.garmin.com/IPC/) and toggle on the Outbound and Inbound settings. Under the Outbound settings, add the public URL of the serverless function in the "Outbound URL" input, and add the authorization token to the "Authentication Method" input. Under the Inbound settings, press edit, and add the username and password to the "IPC User Name" and "IPC User Pass" inputs.
