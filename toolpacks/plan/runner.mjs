export async function createRunnerToolpack(context) {
  return {
    tools: {
      "plan.create": (input) => context.callSupport("plan.create", input),
      "plan.status": (input) => context.callSupport("plan.status", input),
      "plan.update": (input) => context.callSupport("plan.update", input),
      "plan.set_item_status": (input) => context.callSupport("plan.set_item_status", input),
      "plan.close": (input) => context.callSupport("plan.close", input),
    },
  };
}
