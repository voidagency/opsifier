import { type SwarmNode, swarmNodeList } from "@opsifier/contract";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api";
import { formatBytes } from "../../../lib/format";
import { errorMessage } from "../../../lib/forms";
import { Badge, ErrorState, Lamp, Skeleton, Table, TBody, TD, TH, THead, TR } from "../../../ui";

export const serverNodesQuery = {
  queryKey: ["server", "nodes"] as const,
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    api.get("/server/nodes", { schema: swarmNodeList, signal }),
  // A node that goes down shows within the half minute.
  refetchInterval: 30_000,
};

const lampOf = {
  ready: "running",
  down: "failed",
  disconnected: "degraded",
  unknown: "unknown",
} as const satisfies Record<SwarmNode["state"], string>;

/**
 * The servers of the swarm the panel runs, and what runs on each. Read only: adding, draining and
 * removing a node come with the private network between servers.
 */
export function NodesPage() {
  const { t } = useTranslation(["settings-nodes", "common"]);
  const { data, isPending, isError, error, refetch } = useQuery(serverNodesQuery);

  if (isPending) {
    return <Skeleton className="m-6 h-40" />;
  }
  if (isError) {
    return <ErrorState className="m-6" message={errorMessage(error, t)} onRetry={() => refetch()} />;
  }

  const { nodes } = data;
  const managers = nodes.filter((node) => node.role === "manager").length;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 px-4 py-6 md:px-6 lg:px-8">
      <div>
        <h2 className="text-md font-medium">{t("title")}</h2>
        <p className="mt-1 max-w-[70ch] text-sm text-muted">{t("description")}</p>
      </div>

      <section className="grid gap-3 border-t pt-5">
        <p className="text-sm">
          {[
            t("nodes", { count: nodes.length }),
            t("managers", { count: managers }),
            t("workers", { count: nodes.length - managers }),
          ].join(" · ")}
        </p>
        <div className="overflow-x-auto">
          <Table>
            <THead>
              <TR>
                <TH>{t("columns.node")}</TH>
                <TH>{t("columns.role")}</TH>
                <TH>{t("columns.state")}</TH>
                <TH>{t("columns.address")}</TH>
                <TH>{t("columns.resources")}</TH>
                <TH>{t("columns.docker")}</TH>
                <TH numeric>{t("columns.tasks")}</TH>
              </TR>
            </THead>
            <TBody>
              {nodes.map((node) => (
                <TR key={node.id}>
                  <TD>
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <span className="font-medium">{node.hostname}</span>
                      {node.self && <Badge tone="accent">{t("self")}</Badge>}
                      {node.leader && <Badge>{t("leader")}</Badge>}
                    </span>
                  </TD>
                  <TD>{t(`role.${node.role}`)}</TD>
                  <TD>
                    <span className="inline-flex items-center gap-2">
                      <Lamp state={lampOf[node.state]} />
                      {t(`state.${node.state}`)}
                      {node.availability !== "active" && (
                        <span className="text-muted">· {t(`availability.${node.availability}`)}</span>
                      )}
                    </span>
                  </TD>
                  <TD mono>{node.address ?? "–"}</TD>
                  <TD>
                    {[
                      node.cpus === null ? null : t("cores", { count: node.cpus }),
                      node.memoryBytes === null ? null : formatBytes(node.memoryBytes),
                    ]
                      .filter((part) => part !== null)
                      .join(" · ") || "–"}
                  </TD>
                  <TD mono>
                    {node.engineVersion ?? "–"}
                    {node.os !== null && (
                      <span className="ml-2 text-muted">
                        {node.os}
                        {node.architecture === null ? "" : `/${node.architecture}`}
                      </span>
                    )}
                  </TD>
                  <TD numeric>{node.runningTasks}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
        <p className="max-w-[70ch] text-sm text-muted">{t("readOnly")}</p>
      </section>
    </div>
  );
}
