//@ts-ignore
import * as functions from "firebase-functions";
import * as admin from "firebase-admin/app";
import * as firestore from "firebase-admin/firestore";
import { JWT } from 'google-auth-library';
import { google } from 'googleapis';
//@ts-ignore
import iap from 'in-app-purchase';

import devJson from './fb-service.json';
import payJson from './payment-service.json';

admin.initializeApp({
  credential: admin.cert({
    clientEmail: devJson.client_email,
    privateKey: devJson.private_key,
    projectId: devJson.project_id,
  }),
  databaseURL: "https://babytube-dev-default-rtdb.firebaseio.com"
});

google.options({ auth: new JWT(
  payJson.client_email,
  undefined,
  payJson.private_key,
  ['https://www.googleapis.com/auth/androidpublisher'],
) });

const iapTestMode = true;

iap.config({
    appleExcludeOldTransactions: true,
    applePassword: 'd90dc8201d7246948b69039d71b06c2a',
  
    googleServiceAccount: {
      clientEmail: payJson.client_email,
      privateKey: payJson.private_key,
    },
    test: iapTestMode, 
  });
  
  
  const androidGoogleApi = google.androidpublisher({ version: 'v3' });
  
  async function updateSubscription({
    app, origTxId, userId, validationResponse, latestReceipt, productId, 
  }: {
    app: string, origTxId: string, userId: string, validationResponse: any, latestReceipt: string, productId: string, 
  }) {
    const data = {
      app,
      user_id: userId,
      orig_tx_id: origTxId,
      validation_response: JSON.stringify(validationResponse),
      latest_receipt: latestReceipt,
      product_id: productId,
    };
  
    try {
      await firestore.getFirestore().runTransaction(async transaction => {
        const purchaseReference = firestore.getFirestore().collection('Purchases').doc(data.orig_tx_id);
        const userReference = firestore.getFirestore().collection('Users').doc(data.user_id);
  
        if((await purchaseReference.get()).exists) {
          await transaction.update(userReference, {
            isLettersPurchase: true
          });
          return;
        }
        await transaction.set(purchaseReference, data);
        await transaction.update(userReference, {
          isLettersPurchase: true
        });
      });
  
    } catch (err) {
        throw new functions.https.HttpsError('unknown', 'firestore updateSubscription error', err);  
    }
  }
  
  
  
  async function processPurchase(app: 'ios' | 'android', userId: string, receipt: {
    packageName: string,
    productId: string,
    purchaseToken: string,
    subscription: boolean,
  }) {
    await iap.setup();
    const validationResponse: any = await iap.validate(receipt);
    
    if(validationResponse === undefined) {
        throw new functions.https.HttpsError('unavailable', 'validationResponse === undefined');  
    }
    if((app === 'ios' && validationResponse.service === 'google')
    || (app === 'android' && validationResponse.service === 'apple')){
        throw new functions.https.HttpsError('unavailable', `app: ${app} and validationResponse.service: ${validationResponse.service} do not match`);
    }
  
    const purchaseData = iap.getPurchaseData(validationResponse);
    if(!purchaseData) {
      throw new functions.https.HttpsError('unavailable', 'no purchaseData'); 
    }
    console.log('purchaseData', purchaseData);
    
    const firstPurchaseItem: any = purchaseData[0];
  
    const isCancelled = iap.isCanceled(firstPurchaseItem);
    const isExpired = iap.isExpired(firstPurchaseItem);
    const { productId } = firstPurchaseItem;
    const origTxId = app === 'ios' ? firstPurchaseItem.originalTransactionId : firstPurchaseItem.transactionId;
    const latestReceipt = JSON.stringify(receipt);
  
    if(isCancelled) {
      throw new functions.https.HttpsError('unavailable', 'isCancelled'); 
    }
    if(isExpired) {  
        throw new functions.https.HttpsError('unavailable', 'isExpired');
    }
  
    await updateSubscription({
      userId,
      app,
      productId,
      origTxId: origTxId!,
      latestReceipt,
      validationResponse,
    });
  
  
    if (app === 'android' && validationResponse.acknowledgementState === 0) {
      await androidGoogleApi.purchases.products.acknowledge({
        packageName: firstPurchaseItem.packageName,
        productId: productId,
        token: receipt.purchaseToken,
  
      });
      
    }
  }
  

exports.saveReceipt = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Endpoint requires authentication!');
    }

    const userId = context.auth.uid;
    const { appType, purchase } = data;  
  
    const receipt = appType === 'ios' ? purchase.transactionReceipt : {
      packageName: purchase.packageNameAndroid,
      productId: purchase.productId,
      purchaseToken: purchase.purchaseToken,
      subscription: false,
    };
  
    await processPurchase(appType, userId, receipt);
    return { success: true };
});
