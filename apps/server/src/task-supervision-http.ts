import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { cloudIdentitySchema } from "./cloud.js";
import type { PostgresTaskDatabase } from "./task-database.js";
import type { TaskService } from "./tasks.js";

const taskIdSchema = z.string().uuid();
const taskQuerySchema = cloudIdentitySchema.extend({
  limit: z.number().int().min(1).max(200).default(100),
}).strict();

type WebPreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export function registerTaskSupervisionHttp(
  app: FastifyInstance,
  dependencies: {
    preHandler: WebPreHandler;
    database: Pick<PostgresTaskDatabase, "listTasks">;
    service: Pick<TaskService, "superviseTask">;
  },
): void {
  app.post(
    "/v1/internal/tasks/query",
    { preHandler: dependencies.preHandler },
    async (request, reply) => {
      const parsed = taskQuerySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_task_query" });
      }
      return {
        data: await dependencies.database.listTasks(
          parsed.data.organization.externalId,
          parsed.data.limit,
        ),
      };
    },
  );

  for (const decision of ["approve", "deny"] as const) {
    app.post<{ Params: { taskId: string } }>(
      `/v1/internal/tasks/:taskId/${decision}`,
      { preHandler: dependencies.preHandler },
      async (request, reply) => {
        const taskId = taskIdSchema.safeParse(request.params.taskId);
        const identity = cloudIdentitySchema.safeParse(request.body);
        if (!taskId.success || !identity.success) {
          return reply.code(400).send({ error: "invalid_task_decision" });
        }
        const result = await dependencies.service.superviseTask(
          {
            organizationId: identity.data.organization.externalId,
            humanId: identity.data.userId,
            role: identity.data.role,
          },
          taskId.data,
          decision,
        );
        if (result.status === "denied_request") {
          return reply
            .code(result.code === "task_not_found" ? 404 : 409)
            .send({ error: result.code });
        }
        return reply
          .code(result.status === "approved" ? 202 : 200)
          .send({ task: result.task, delivery: result.delivery });
      },
    );
  }
}
