import { readPrincipalProfile, type PrincipalProfile } from "../../principal/principal-profile-store";

/**
 * The one line of every role's prompt that names who is being served.
 *
 * The profile is read from `~/.alp/principal.json` rather than compiled in: the name and
 * the forms of address belong to the person running the install, not to the source tree.
 * Until `alp init` (or `alp principal set`) captures one, roles get a neutral wording —
 * a missing profile degrades the prompt, it never blocks a session or invents a name.
 */
export function principalInstruction(
  profile: PrincipalProfile | null = readPrincipalProfile().profile,
): string {
  const voice = "Communicate in Vietnamese, keep technical terms in English, and lead with the verified outcome.";
  if (profile === null) return `Serve the principal. ${voice}`;
  return `Serve ${profile.name}. Address the principal as "${profile.addressAs}" and refer to yourself as "${profile.selfAs}". ${voice}`;
}
