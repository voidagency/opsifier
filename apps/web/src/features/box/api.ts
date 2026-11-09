import {
  type ApplyBoxPresetRequest,
  actionEntry,
  boxDetail,
  boxIdeStatus,
  boxProcessesStatus,
  type CreateBoxRequest,
  type IssueBoxIdeTokenRequest,
  issuedBoxIdeToken,
  type SaveBoxHooksRequest,
  type SaveBoxModulesRequest,
  type SaveBoxProcessesRequest,
  serviceDetail,
} from "@opsifier/contract";
import { queryOptions } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { serviceKey } from "../services/api";

const base = (project: string, service: string) => `/projects/${project}/services/${service}/box`;

export const boxQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: [...serviceKey(project, service), "box"] as const,
    queryFn: ({ signal }) => api.get(base(project, service), { schema: boxDetail, signal }),
    staleTime: 0,
  });

export const boxProcessesQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: [...serviceKey(project, service), "box", "processes"] as const,
    queryFn: ({ signal }) =>
      api.get(`${base(project, service)}/processes/status`, { schema: boxProcessesStatus, signal }),
    staleTime: 0,
  });

export const boxIdeQuery = (project: string, service: string) =>
  queryOptions({
    queryKey: [...serviceKey(project, service), "box", "ide"] as const,
    queryFn: ({ signal }) => api.get(`${base(project, service)}/ide`, { schema: boxIdeStatus, signal }),
    staleTime: 0,
  });

export const boxApi = {
  create: (project: string, body: CreateBoxRequest) =>
    api.post(`/projects/${project}/box`, { body, schema: serviceDetail }),
  saveModules: (project: string, service: string, body: SaveBoxModulesRequest) =>
    api.put(`${base(project, service)}/modules`, { body, schema: boxDetail }),
  saveProcesses: (project: string, service: string, body: SaveBoxProcessesRequest) =>
    api.put(`${base(project, service)}/processes`, { body, schema: boxDetail }),
  saveHooks: (project: string, service: string, body: SaveBoxHooksRequest) =>
    api.put(`${base(project, service)}/hooks`, { body, schema: boxDetail }),
  applyPreset: (project: string, service: string, body: ApplyBoxPresetRequest) =>
    api.post(`${base(project, service)}/preset`, { body, schema: boxDetail }),
  restartProcess: (project: string, service: string, process: string) =>
    api.post(`${base(project, service)}/processes/${process}/restart`, { schema: actionEntry }),
  setIde: (project: string, service: string, enabled: boolean) =>
    api.put(`${base(project, service)}/ide`, { body: { enabled }, schema: boxIdeStatus }),
  issueIdeToken: (project: string, service: string, body: IssueBoxIdeTokenRequest) =>
    api.post(`${base(project, service)}/ide/token`, { body, schema: issuedBoxIdeToken }),
  revokeIdeToken: (project: string, service: string) =>
    api.delete(`${base(project, service)}/ide/token`, { schema: boxIdeStatus }),
};
