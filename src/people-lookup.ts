import {
  defaultGlobalIdentityPath,
  loadExplicitIdentities,
  type SlackDirectoryUser,
} from "./git-slack-identities.ts";

export interface PersonMatch {
  userId: string;
  name: string;
  handle?: string;
  match: "email" | "git_email" | "handle" | "name" | "partial_name";
}

/** Directory results are candidates; only an explicit Slack ID can be used for delivery. */
export function findPeople(
  query: string,
  users: readonly SlackDirectoryUser[],
  repository: string,
  globalIdentityPath = defaultGlobalIdentityPath(),
): PersonMatch[] {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2 || needle.length > 200 || /[\r\n\x00-\x1f]/.test(query)) {
    throw new Error("Search must be 2–200 characters on one line");
  }
  const isEmail = needle.includes("@") && !needle.startsWith("@");
  const nameQuery = needle.replace(/^@/, "");
  let mappedId: string | undefined;
  if (isEmail) {
    try {
      mappedId = loadExplicitIdentities(repository, globalIdentityPath).get(needle);
    } catch {
      // A malformed optional mapping file must not disable exact Slack email lookup.
    }
  }
  const ranked: Array<{ person: PersonMatch; rank: number }> = [];
  for (const user of users) {
    let rank = 0;
    let match: PersonMatch["match"] | undefined;
    if (isEmail) {
      if (user.email?.toLowerCase() === needle) {
        rank = 5;
        match = "email";
      } else if (user.id === mappedId) {
        rank = 4;
        match = "git_email";
      }
    } else if (user.handle?.toLowerCase() === nameQuery) {
      rank = 3;
      match = "handle";
    } else if (
      [user.name, user.realName, user.displayName].some((name) => name?.toLowerCase() === nameQuery)
    ) {
      rank = needle.startsWith("@") ? 3 : 2;
      match = "name";
    } else if (
      nameQuery.length >= 3 &&
      [user.name, user.realName, user.displayName, user.handle].some(
        (name) =>
          name &&
          (name.toLowerCase().startsWith(nameQuery) ||
            name
              .toLowerCase()
              .split(/[\s._-]+/)
              .some((word) => word.startsWith(nameQuery))),
      )
    ) {
      rank = 1;
      match = "partial_name";
    }
    if (match) {
      ranked.push({
        rank,
        person: {
          userId: user.id,
          name: (user.name ?? user.handle ?? user.id).slice(0, 120),
          ...(user.handle ? { handle: user.handle.slice(0, 80) } : {}),
          match,
        },
      });
    }
  }
  return ranked
    .sort((a, b) => b.rank - a.rank || a.person.name.localeCompare(b.person.name))
    .slice(0, 5)
    .map(({ person }) => person);
}
