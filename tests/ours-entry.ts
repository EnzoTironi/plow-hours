import channel from "../plugin/index.ts";
import hours from "../plugin/ours.ts";

// The installed runtime loads both entries, not a patched combined registration.
export default {
  ...channel,
  register(api: Parameters<typeof channel.register>[0]) {
    channel.register(api);
    hours.register(api);
  },
};
