import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { cloudIdentitySchema } from "./cloud.js";
import type { PostgresSessionDatabase } from "./session-database.js";
import type { SessionService } from "./sessions.js";

const sessionIdSchema = z.string().uuid();
const sessionQuerySchema = cloudIdentitySchema.extend({
  limit: z.number().int().min(1).max(200).default(100),
}).strict();

type WebPreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export function registerSessionSupervisionHttp(
  app: FastifyInstance,
  dependencies: {
    preHandler: WebPreHandler;
    database: Pick<PostgresSessionDatabase, "listSessions" | "sessionTimeline">;
    service: Pick<SessionService, "superviseSession">;
  },
): void {
  app.post(
    "/v1/internal/sessions/query",
    { preHandler: dependencies.preHandler },
    async (request, reply) => {
      const parsed = sessionQuerySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_session_query" });
      }
      return {
        data: await dependencies.database.listSessions(
          parsed.data.organization.externalId,
          parsed.data.limit,
        ),
      };
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/v1/internal/sessions/:sessionId/timeline",
    { preHandler: dependencies.preHandler },
    async (request, reply) => {
      const sessionId = sessionIdSchema.safeParse(request.params.sessionId);
      const identity = cloudIdentitySchema.safeParse(request.body);
      if (!sessionId.success || !identity.success) {
        return reply.code(400).send({ error: "invalid_session_timeline" });
      }
      const timeline = await dependencies.database.sessionTimeline(
        identity.data.organization.externalId,
        sessionId.data,
      );
      return timeline ?? reply.code(404).send({ error: "session_not_found" });
    },
  );

  for (const decision of ["approve", "deny"] as const) {
    app.post<{ Params: { sessionId: string } }>(
      `/v1/internal/sessions/:sessionId/${decision}`,
      { preHandler: dependencies.preHandler },
      async (request, reply) => {
        const sessionId = sessionIdSchema.safeParse(request.params.sessionId);
        const identity = cloudIdentitySchema.safeParse(request.body);
        if (!sessionId.success || !identity.success) {
          return reply.code(400).send({ error: "invalid_session_decision" });
        }
        const result = await dependencies.service.superviseSession(
          {
            organizationId: identity.data.organization.externalId,
            humanId: identity.data.userId,
            role: identity.data.role,
          },
          sessionId.data,
          decision,
        );
        if (result.status === "denied_request") {
          return reply
            .code(result.code === "session_not_found" ? 404 : 409)
            .send({ error: result.code });
        }
        return reply
          .code(result.status === "approved" ? 202 : 200)
          .send({ session: result.session, delivery: result.delivery });
      },
    );
  }
}
