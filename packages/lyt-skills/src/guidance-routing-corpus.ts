/*
 * Copyright 2026 MARLINK TRADING SRL (YounndAI)
 * Licensed under the Apache License, Version 2.0.
 */

export type GuidanceRouteCaseV1 = Readonly<{
  id: string;
  signal: string;
  route: string;
  cliFamily: string;
  forbiddenRoutes: readonly string[];
  ambiguity: "ask" | "exact-only" | "not-applicable";
}>;

/** Machine-checkable routing law shared by source, packed, and dogfood proof. */
export const GUIDANCE_ROUTING_CORPUS_V1: readonly GuidanceRouteCaseV1[] = Object.freeze([
  {
    id: "create-mesh",
    signal: "create a new mesh",
    route: "/lyt-create",
    cliFamily: "lyt mesh init",
    forbiddenRoutes: ["raw-git", "raw-gh", "/lyt-adopt"],
    ambiguity: "ask",
  },
  {
    id: "create-vault",
    signal: "create a new vault",
    route: "/lyt-create",
    cliFamily: "lyt vault init",
    forbiddenRoutes: ["raw-git", "raw-gh", "/lyt-capture"],
    ambiguity: "ask",
  },
  {
    id: "adopt-directory",
    signal: "bring this existing directory into Lyt",
    route: "/lyt-adopt",
    cliFamily: "lyt vault adopt",
    forbiddenRoutes: ["lyt vault init", "raw-git"],
    ambiguity: "ask",
  },
  {
    id: "capture-note",
    signal: "save this durable note",
    route: "/lyt-capture",
    cliFamily: "lyt capture",
    forbiddenRoutes: ["lyt vault init", "/lyt-create"],
    ambiguity: "ask",
  },
  {
    id: "inspect-mesh",
    signal: "show me one named mesh",
    route: "/lyt-mesh-explore",
    cliFamily: "lyt mesh info",
    forbiddenRoutes: ["prefix-inference", "raw-filesystem"],
    ambiguity: "exact-only",
  },
  {
    id: "check-vault",
    signal: "check whether this vault needs sync",
    route: "/lyt-sync",
    cliFamily: "lyt sync --check --vault",
    forbiddenRoutes: ["raw-git", "pod-wide-sync"],
    ambiguity: "exact-only",
  },
  {
    id: "alias-vault",
    signal: "give this vault a short name",
    route: "/lyt-alias",
    cliFamily: "lyt alias",
    forbiddenRoutes: ["auto-alias", "rename-vault"],
    ambiguity: "ask",
  },
  {
    id: "recover",
    signal: "diagnose or repair Lyt",
    route: "lyt help troubleshooting",
    cliFamily: "lyt doctor / lyt repair",
    forbiddenRoutes: ["raw-git", "invented-repair-flags"],
    ambiguity: "not-applicable",
  },
  {
    id: "update",
    signal: "check or update Lyt",
    route: "/lyt-update",
    cliFamily: "lyt outdated / lyt update / lyt install reconcile",
    forbiddenRoutes: ["raw-npm", "silent-update"],
    ambiguity: "not-applicable",
  },
]);
