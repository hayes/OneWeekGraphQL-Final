import { createServer, GraphQLYogaError } from '@graphql-yoga/node';
import type { PrismaClient } from '@prisma/client';
import type { NextApiRequest, NextApiResponse } from 'next';
import currencyFormatter from 'currency-formatter';
import SchemaBuilder from '@pothos/core';
import PrismaPlugin from '@pothos/plugin-prisma';
import type PrismaTypes from '@pothos/plugin-prisma/generated';

import prisma from '../../lib/prisma';
import { stripe } from '../../lib/stripe';
import { origin } from '../../lib/client';

export type GraphQLContext = {
  prisma: PrismaClient;
};

export async function createContext(): Promise<GraphQLContext> {
  return {
    prisma,
  };
}

const currencyCode = 'USD';

const builder = new SchemaBuilder<{
  Context: GraphQLContext;
  PrismaTypes: PrismaTypes;
  Scalars: {
    ID: { Input: string; Output: string };
  };
}>({
  plugins: [PrismaPlugin],
  prisma: {
    client: prisma,
  },
});

builder.queryType({
  fields: (t) => ({
    cart: t.prismaField({
      type: 'Cart',
      args: {
        id: t.arg.id({ required: true }),
      },
      resolve: (query, _, { id }) =>
        prisma.cart.upsert({
          ...query,
          where: { id },
          update: {},
          create: {
            id,
          },
        }),
    }),
  }),
});

const Money = builder.objectRef<number>('Money').implement({
  fields: (t) => ({
    amount: t.int({ resolve: (amount) => amount }),
    formatted: t.string({
      resolve: (amount) =>
        currencyFormatter.format(amount / 100, {
          code: currencyCode,
        }),
    }),
  }),
});

builder.prismaObject('Cart', {
  findUnique: ({ id }) => ({ id }),
  fields: (t) => ({
    id: t.exposeID('id', {}),
    totalItems: t.int({
      select: {
        items: true,
      },
      resolve: (cart) =>
        cart.items.reduce((total, item) => total + item.quantity || 1, 0),
    }),
    items: t.relation('items'),
    subTotal: t.field({
      select: {
        items: true,
      },
      type: Money,
      resolve: (cart) =>
        cart.items.reduce((acc, item) => acc + item.price * item.quantity, 0) ??
        0,
    }),
  }),
});

builder.prismaObject('CartItem', {
  findUnique: ({ id, cartId }) => ({ id_cartId: { id, cartId } }),
  fields: (t) => ({
    id: t.exposeID('id'),
    name: t.exposeString('name'),
    description: t.exposeString('description', { nullable: true }),
    quantity: t.exposeInt('quantity'),
    image: t.exposeString('image', { nullable: true }),
    unitTotal: t.expose('price', { type: Money }),
    lineTotal: t.field({
      type: Money,
      resolve: (item) => item.price * item.quantity,
    }),
  }),
});

builder.mutationType({});

const AddToCartInput = builder.inputType('AddToCartInput', {
  fields: (t) => ({
    cartId: t.id({ required: true }),
    id: t.id({ required: true }),
    name: t.string({ required: true }),
    description: t.string(),
    image: t.string(),
    price: t.int({ required: true }),
    quantity: t.int({ defaultValue: 1 }),
  }),
});

builder.mutationField('addItem', (t) =>
  t.prismaField({
    type: 'Cart',
    args: {
      input: t.arg({ required: true, type: AddToCartInput }),
    },
    resolve: (query, _, { input }) => {
      const item = {
        id: input.id,
        name: input.name,
        description: input.description,
        image: input.image,
        price: input.price,
        quantity: input.quantity ?? 1,
      };

      return prisma.cart.upsert({
        ...query,
        where: { id: input.cartId },
        create: {
          id: input.cartId,
          items: {
            create: item,
          },
        },
        update: {
          items: {
            upsert: {
              create: item,
              where: { id_cartId: { id: input.id, cartId: input.cartId } },
              update: {
                quantity: {
                  increment: input.quantity ?? 1,
                },
              },
            },
          },
        },
      });
    },
  })
);

const RemoveFromCartInput = builder.inputType('RemoveFromCartInput', {
  fields: (t) => ({
    cartId: t.id({ required: true }),
    id: t.id({ required: true }),
  }),
});

builder.mutationField('removeItem', (t) =>
  t.prismaField({
    type: 'Cart',
    args: {
      input: t.arg({ type: RemoveFromCartInput, required: true }),
    },
    resolve: (query, _, { input }) =>
      prisma.cart.update({
        ...query,
        where: { id: input.id },
        data: {
          items: {
            deleteMany: {
              id: input.id,
            },
          },
        },
      }),
  })
);

const IncreaseCartItemInput = builder.inputType('IncreaseCartItemInput', {
  fields: (t) => ({
    cartId: t.id({ required: true }),
    id: t.id({ required: true }),
  }),
});

builder.mutationField('increaseCartItem', (t) =>
  t.prismaField({
    type: 'Cart',
    args: {
      input: t.arg({ type: IncreaseCartItemInput, required: true }),
    },
    resolve: (query, _, { input }) =>
      prisma.cart.update({
        ...query,
        where: { id: input.id },
        data: {
          items: {
            updateMany: {
              where: { id: input.id },
              data: {
                quantity: {
                  increment: 1,
                },
              },
            },
          },
        },
      }),
  })
);

const DecreaseCartItemInput = builder.inputType('DecreaseCartItemInput', {
  fields: (t) => ({
    cartId: t.id({ required: true }),
    id: t.id({ required: true }),
  }),
});

builder.mutationField('decreaseCartItem', (t) =>
  t.prismaField({
    type: 'Cart',
    args: {
      input: t.arg({ type: DecreaseCartItemInput, required: true }),
    },
    resolve: (query, _, { input }) =>
      prisma.cart.update({
        ...query,
        where: { id: input.id },
        data: {
          items: {
            updateMany: {
              where: { id: input.id, quantity: { gte: 1 } },
              data: {
                quantity: {
                  decrement: 1,
                },
              },
            },
          },
        },
      }),
  })
);

const CreateCheckoutSessionInput = builder.inputType(
  'CreateCheckoutSessionInput',
  {
    fields: (t) => ({
      cartId: t.id({ required: true }),
    }),
  }
);

const CheckoutSession = builder
  .objectRef<{ id: string; url: string | null }>('CheckoutSession')
  .implement({
    fields: (t) => ({
      id: t.exposeID('id'),
      url: t.exposeID('url', { nullable: true }),
    }),
  });

builder.mutationField('createCheckoutSession', (t) =>
  t.field({
    type: CheckoutSession,
    args: {
      input: t.arg({ type: CreateCheckoutSessionInput, required: true }),
    },
    resolve: async (_, { input }) => {
      const { cartId } = input;

      const cart = await prisma.cart.findUnique({
        where: { id: cartId },
        include: {
          items: true,
        },
      });

      if (!cart) {
        throw new GraphQLYogaError('Invalid cart');
      }

      if (!cart.items || cart.items.length === 0) {
        throw new GraphQLYogaError('Cart is empty');
      }

      const line_items = cart.items.map((item) => {
        return {
          quantity: item.quantity,
          price_data: {
            currency: currencyCode,
            unit_amount: item.price,
            product_data: {
              name: item.name,
              description: item.description || undefined,
              images: item.image ? [item.image] : [],
            },
          },
        };
      });

      const session = await stripe.checkout.sessions.create({
        success_url: `${origin}/thankyou?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/cart?cancelled=true`,
        line_items,
        metadata: {
          cartId: cart.id,
        },
        mode: 'payment',
      });

      return {
        id: session.id,
        url: session.url,
      };
    },
  })
);

const server = createServer<{
  req: NextApiRequest;
  res: NextApiResponse;
}>({
  endpoint: '/api',
  schema: builder.toSchema({}),
  context: createContext(),
});

export default server.requestListener;
