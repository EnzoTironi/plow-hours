import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { z } from "zod";
import { authorizeHoursOwner, registerHours } from "./hours-channel.ts";
import { registerHoursWeb } from "./hours-web.ts";

const account = z.object({ apiBase: z.string(), lineUid: z.string() });

export default {
  id: "ours",
  name: "Ours",
  register(api: OpenClawPluginApi) {
    registerHours(api, async context => {
      const configuration = { ...account.parse(context.config?.channels?.plow), accountId: "chat" };
      return { account: configuration, ...await authorizeHoursOwner(configuration, context) };
    });
    if (api.registrationMode === "full") registerHoursWeb(api);
  },
};
