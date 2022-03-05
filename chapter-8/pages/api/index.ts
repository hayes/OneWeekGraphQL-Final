import { createServer } from "@graphql-yoga/node";
import type { YogaInitialContext } from "@graphql-yoga/node";
import { join } from "path";
import { readFileSync } from "fs";
import currencyFormatter from "currency-formatter";
import type { PrismaClient } from "@prisma/client";

import prisma from "../../lib/prisma";
import { Resolvers } from "../../types";
import { findOrCreateCart } from "../../lib/cart";

const currencyCode = "USD";

const typeDefs = readFileSync(join(process.cwd(), "schema.graphql"), {
  encoding: "utf-8",
});

const resolvers: Resolvers = {
  Query: {
    cart: async (_, { id }) => {
      return findOrCreateCart(id);
    },
  },
  Mutation: {
    addItem: async (_, { input }) => {
      await prisma.cartItem.upsert({
        create: {
          cartId: input.cartId,
          id: input.id,
          name: input.name,
          description: input.description,
          image: input.image,
          price: input.price,
          quantity: input.quantity || 1,
        },
        where: { id_cartId: { id: input.id, cartId: input.cartId } },
        update: {
          quantity: {
            increment: input.quantity || 1,
          },
        },
      });
      return findOrCreateCart(input.cartId);
    },
  },
  Cart: {
    items: async ({ id }, _, { prisma }) => {
      // https://www.prisma.io/docs/guides/performance-and-optimization/query-optimization-performance#solving-n1-in-graphql-with-findunique-and-prismas-dataloader
      const items = await prisma.cart
        .findUnique({
          where: { id },
        })
        .items();
      return items;
    },
    totalItems: async ({ id }, _, { prisma }) => {
      const items = await prisma.cart
        .findUnique({
          where: { id },
        })
        .items();
      return items.reduce((total, item) => total + item.quantity || 1, 0);
    },
    subTotal: async ({ id }, _, { prisma }) => {
      const items = await prisma.cart
        .findUnique({
          where: { id },
        })
        .items();
      const amount =
        items.reduce((acc, item) => acc + item.price * item.quantity, 0) ?? 0;
      return {
        amount,
        formatted: currencyFormatter.format(amount / 100, {
          code: currencyCode,
        }),
      };
    },
  },
  CartItem: {
    unitTotal: (item) => {
      const amount = item.price;
      return {
        amount,
        formatted: currencyFormatter.format(amount / 100, {
          code: currencyCode,
        }),
      };
    },
    lineTotal: (item) => {
      const amount = item.quantity * item.price;

      return {
        amount,
        formatted: currencyFormatter.format(amount / 100, {
          code: currencyCode,
        }),
      };
    },
  },
};

// export type GraphQLContext = {
//   prisma: PrismaClient;
// };

export interface GraphQLContext extends YogaInitialContext {
  prisma: PrismaClient;
}

const server = createServer<GraphQLContext, null>({
  cors: false,
  endpoint: "/api",
  logging: {
    prettyLog: false,
  },
  schema: {
    typeDefs,
    resolvers,
  },
  context: ({ request }) => ({
    request,
    prisma,
  }),
});

export const config = {
  api: {
    bodyParser: false,
    externalResolver: true,
  },
};

export default server.requestListener;
