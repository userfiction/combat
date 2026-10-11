// ============================================================================
// @userfiction/combat — src/ids.ts — T1 id pattern + namespacing helper
// ============================================================================
// Tiny shared identity vocabulary used by validation (T2: entity/team/status
// ids), plugins (T4: plugin ids + namespaced vocab type ids) and the JSON
// rule interpreter (T4: 'pluginId/name' resolution). Zero dependencies (D14).
//
// Precedent: @userfiction/reader/plugin/registry.ts L110–111 defines
// namespacedContributionId as `${pluginId}/${contributionId}` so ids from
// different plugins can never collide accidentally; combat reuses the exact
// scheme for plugin vocab condition/effect type ids (D8: namespaced
// 'pluginId/name' types) and for the synthetic '@definition/rules' plugin
// that carries JSON contributions (D6).
// ============================================================================

// Entity/team/status id pattern (D3: "reader id convention"). Lowercase
// alphanumeric start, then lowercase alphanumerics and dashes. Exported as a
// constant so validation error messages and tests reference ONE pattern.
export const ENTITY_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

// Type-guard form of the pattern check — validation receives untrusted JSON,
// so the input is `unknown` and a failed check is a collected error, never a
// throw (reader precedent: collect ALL errors, report together).
export const isValidId = (value: unknown): value is string =>
    typeof value === 'string' && ENTITY_ID_PATTERN.test(value);

// Namespaced contribution/vocab id: 'pluginId/name' (reader precedent
// registry.ts L110–111). Matches the CustomTypeId template-literal type in
// types.ts (built-in vocabulary type strings never contain '/', keeping the
// discriminated unions disjoint).
export const namespaced = (pluginId: string, id: string): string => `${pluginId}/${id}`;
