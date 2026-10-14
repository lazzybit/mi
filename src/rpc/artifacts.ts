"use server";

import type { ArtifactPage, ArtifactReadQuery } from "../shared/domain";
import { requireRpcContext } from "../worker/rpc/RpcContext";

export async function readArtifact(query: ArtifactReadQuery): Promise<ArtifactPage> {
  return requireRpcContext().ownerStub.readArtifact(query);
}
