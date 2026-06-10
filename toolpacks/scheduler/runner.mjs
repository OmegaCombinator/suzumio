export async function createRunnerToolpack(context) {
  return {
    tools: {
      "schedule.once": (input) => context.callSupport("schedule.once", input),
      "schedule.recurring": (input) => context.callSupport("schedule.recurring", input),
      "schedule.list": (input) => context.callSupport("schedule.list", input),
      "schedule.cancel": (input) => context.callSupport("schedule.cancel", input),
    },
  };
}
