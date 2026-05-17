// Voyager API URLs and content-hash GraphQL query IDs.
//
// Copied verbatim from mautrix-linkedin pkg/linkedingo/constants.go so this
// client speaks the same dialect as the bridge. When LinkedIn ships new
// query hashes, sync these from the upstream Go file.

export const BASE = "https://www.linkedin.com";
export const VOYAGER = BASE + "/voyager/api";
export const GRAPHQL_URL = VOYAGER + "/voyagerMessagingGraphQL/graphql";
export const MESSAGES_URL = VOYAGER + "/voyagerMessagingDashMessengerMessages";
export const REALTIME_URL = BASE + "/realtime/connect";
export const HEARTBEAT_URL =
  BASE + "/realtime/realtimeFrontendClientConnectivityTracking";

export const messengerConversations =
  "messengerConversations.0d5e6781bbee71c3e51c8843c6519f48";
export const messengerConversationsWithSyncToken =
  "messengerConversations.74c17e85611b60b7ba2700481151a316";
export const messengerConversationsWithCursor =
  "messengerConversations.8656fb361a8ad0c178e8d3ff1a84ce26";
export const messengerMessagesByAnchorTimestamp =
  "messengerMessages.4088d03bc70c91c3fa68965cb42336de";
export const messengerMessagesByPrevCursor =
  "messengerMessages.34c9888be71c8010fecfb575cb38308f";
