import {
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { NeonDatabase } from 'drizzle-orm/neon-serverless';
import { DATABASE_CONNECTION } from 'src/database/database-connection';
import * as schemas from 'schemas/tables';
import { desc, eq, gte, ilike, sql } from 'drizzle-orm';
import { AuthInterface } from 'src/auth/interfaces';
import { User } from '../interfaces';
import { today } from 'src/common/constants/today.date';

@Injectable()
export class UserRepository {
  constructor(
    @Inject(DATABASE_CONNECTION) private db: NeonDatabase<typeof schemas>,
  ) {}

  async findAllUsers(page: number = 1, limit: number = 20) {
    try {
      const offset = (page - 1) * limit; //pagination logic
      const users = await this.db
        .select()
        .from(schemas.usersTable)
        .limit(limit)
        .offset(offset)
        .orderBy(desc(schemas.usersTable.createdAt));

      const sanitizedUsers = users.map((user) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { password, ...rest } = user; // hapus password
        return rest;
      });

      return sanitizedUsers;
    } catch (error) {
      console.error('Error fetching all users:', error);
      throw new InternalServerErrorException('Error fetching all users');
    }
  }

  async searchUserByName(name: string) {
    try {
      const users = await this.db
        .select()
        .from(schemas.usersTable)
        .where(ilike(schemas.usersTable.name, `${name}%`));

      const usersSanitized = users.map((user) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { password, ...rest } = user;

        return rest;
      });

      return usersSanitized;
    } catch (error) {
      console.error('Error finding user:', error);
      throw new InternalServerErrorException('Error finding users');
    }
  }

  async createUser({ email, name, password }: AuthInterface) {
    try {
      const [user] = await this.db
        .insert(schemas.usersTable)
        .values({
          email,
          name,
          password,
        })
        .returning();

      return user;
    } catch (error) {
      console.error('Error creating user:', error);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (error.code === '23505') {
        throw new ConflictException(
          `User with Email "${email}" already exists`,
        );
      }
      throw new InternalServerErrorException('Error creating user');
    }
  }

  async findUserByEmail(email: string) {
    try {
      const [user] = await this.db
        .select()
        .from(schemas.usersTable)
        .where(eq(schemas.usersTable.email, email));

      return user || null;
    } catch (error) {
      console.error('Error finding user by Email:', error);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (error.code === '23505') {
        throw new ConflictException(`User with Email "${email}" not found`);
      }
      throw new InternalServerErrorException('Error finding user by Email');
    }
  }

  async findUserById(userId: string) {
    try {
      const [user] = await this.db
        .select()
        .from(schemas.usersTable)
        .where(eq(schemas.usersTable.userId, userId));

      if (!user) {
        throw new NotFoundException(`User with ID "${userId}" not found`);
      }

      return user;
    } catch (error) {
      console.error('Error finding user by Id:', error);

      if (error instanceof NotFoundException) {
        throw error;
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (error.code === '22P02') {
        throw new NotFoundException(`User with ID "${userId}" not found`);
      }

      throw new InternalServerErrorException('Error finding user by Id');
    }
  }

  async updateUser(updateData: Partial<User>, userId: string) {
    try {
      const [user] = await this.db
        .update(schemas.usersTable)
        .set(updateData)
        .where(eq(schemas.usersTable.userId, userId))
        .returning();

      if (!user) {
        throw new InternalServerErrorException('Failed to update user');
      }

      return user;
    } catch (error) {
      console.error('Error updating user:', error);
      throw new InternalServerErrorException(
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        `Error updating user, ${error.detail}`,
      );
    }
  }

  async deleteUser(userId: string) {
    try {
      const [user] = await this.db
        .delete(schemas.usersTable)
        .where(eq(schemas.usersTable.userId, userId))
        .returning();

      if (!user) {
        throw new InternalServerErrorException('Failed to delete user');
      }

      return user;
    } catch (error) {
      console.error('Error deleting user:', error);
      throw new InternalServerErrorException('Error deleting user');
    }
  }

  async newUsersToday() {
    try {
      const [{ count }] = await this.db
        .select({ count: sql`COUNT(*)`.as('count') })
        .from(schemas.usersTable)
        .where(gte(schemas.usersTable.createdAt, today));

      return Number(count);
    } catch (error) {
      console.error('Error fetching new users today:', error);
      throw new InternalServerErrorException('Error fetching new users today');
    }
  }

  async changePw(password: string, userId: string) {
    try {
      const [result] = await this.db
        .update(schemas.usersTable)
        .set({ password: password })
        .where(eq(schemas.usersTable.userId, userId))
        .returning();

      return result;
    } catch (error) {
      console.error('Error changing password: ', error);
      throw new InternalServerErrorException('Error changing password');
    }
  }
}
