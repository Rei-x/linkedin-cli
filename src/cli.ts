#!/usr/bin/env node
import { defineCommand, runMain } from "citty";

const main = defineCommand({
  meta: {
    name: "linkedin",
    version: "0.1.0",
    description: "Command-line client for LinkedIn messaging",
  },
  subCommands: {
    login: () => import("./commands/login.js").then((m) => m.command),
    logout: () => import("./commands/logout.js").then((m) => m.command),
    status: () => import("./commands/status.js").then((m) => m.command),
    chats: () => import("./commands/chats.js").then((m) => m.command),
    read: () => import("./commands/read.js").then((m) => m.command),
    send: () => import("./commands/send.js").then((m) => m.command),
    compose: () => import("./commands/compose.js").then((m) => m.command),
    sync: () => import("./commands/sync.js").then((m) => m.command),
    watch: () => import("./commands/watch.js").then((m) => m.command),
    search: () => import("./commands/search.js").then((m) => m.command),
    "mark-read": () => import("./commands/mark-read.js").then((m) => m.command),
    contacts: () => import("./commands/contacts.js").then((m) => m.command),
  },
});

runMain(main);
