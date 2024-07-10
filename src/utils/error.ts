export class NotFoundError extends Error {
  constructor({ id }: { id: string }) {
    super(`Resource with id '${id}' not found`);
  }
}

export class InvalidInputError extends Error {
  constructor({ reason }: { reason: string }) {
    super(reason);
  }
}
