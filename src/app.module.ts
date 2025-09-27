import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ProductsModule } from './products/products.module';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { DatabaseModule } from './database/database.module';
import { OrdersModule } from './orders/orders.module';
import { PaymentsModule } from './payments/payments.module';
import { PaymentsOrdersSharedModule } from './payments-orders-shared/payments-orders-shared.module';
import { JwtModule } from '@nestjs/jwt';
import { GamesModule } from './games/games.module';
import { UploadModule } from './upload/upload.module';
import { AuditLogModule } from './audit-log/audit-log.module';
import { StatisticsModule } from './statistics/statistics.module';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: '.env', //ganti ke prod
      isGlobal: true,
    }),
    AuthModule,
    JwtModule,
    UsersModule,
    DatabaseModule,
    OrdersModule,
    PaymentsModule,
    ProductsModule,
    PaymentsOrdersSharedModule,
    GamesModule,
    UploadModule,
    AuditLogModule,
    StatisticsModule,
    ThrottlerModule.forRoot({
      throttlers: [
        {
          ttl: 60000, // 1 menit
          limit: 35, // 30 request per menit
        },
      ],
    }),
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
