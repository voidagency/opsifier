/**
 * The names a stack answers to on the networks it shares with the proxy. Docker's DNS answers the
 * proxy from every network it is on, and Compose gives each child its own name, its container's name
 * and any alias the file asks for on every network the child joins. The proxy reaches every other
 * upstream by a name that holds an underscore (`<project>_<service>`, `<project>_<service>__<child>`,
 * `<project>_<service>-<tool>`) or by the panel's, which starts with `opsifier`. A name with neither can
 * never answer in their place.
 */

/** Whether a name could be another project's upstream, or the panel's. Docker's DNS ignores case. */
export const isReservedName = (name: string): boolean => name.includes("_") || /^opsifier/i.test(name);

/**
 * Whether a container name stays within the stack's own, which starts with its Compose project the
 * way Compose names its containers. Project names hold no underscore, so it stays in its project too.
 */
export const isStackContainerName = (name: string, stack: string): boolean =>
  name === stack || [`${stack}-`, `${stack}_`].some((prefix) => name.startsWith(prefix));
