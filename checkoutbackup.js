const { response, resMessage } = require("../../../helpers/common");
const { Cart } = require("../../../models/cart.model");
const { Vendor } = require("../../../models/vendor.model");
const { User } = require("../../../models/user.model");
const { createPaymentIntent } = require("../../../services/payment");
const { Order } = require("../../../models/order.model");
const { Category } = require("../../../models/category.model");
const { Product } = require("../../../models/product.model");
const { sendEmail } = require("../../../services/email");
const Counter = require("./counter");

const makeMongoDbServiceCart = require("../../../services/mongoDbService")({
  model: Cart,
});
const makeMongoDbServiceOrder = require("../../../services/mongoDbService")({
  model: Order,
});
const makeMongoDbServiceCategory = require("../../../services/mongoDbService")({
  model: Category,
});
const makeMongoDbServiceVendor = require("../../../services/mongoDbService")({
  model: Vendor,
});
const makeMongoDbServiceProduct = require("../../../services/mongoDbService")({
  model: Product,
});
const makeMongoDbServiceUser = require("../../../services/mongoDbService")({
  model: User,
});

exports.accounting = async (req) => {
  const unitShippingCost_nextProducts = 2;
  try {
    let cartId = req.body.cartId;
    let orderAccounting = {};
    let cartAccountingList = [];
    let vendors = [];
    let vendorsList = await makeMongoDbServiceVendor.getDocumentByQuery({
      status: { $ne: "D" },
    });
    let users = await makeMongoDbServiceUser.getDocumentByQuery({
      status: { $ne: "D" },
    });
    vendorsList.forEach((u) => {
      vendors.push(u);
    });
    users.forEach((u) => {
      vendors.push(u);
    });
    vendors = vendors.reduce((obj, item) => ((obj[item._id] = item), obj), {});
    let products = await makeMongoDbServiceProduct.getDocumentByQuery({
      status: { $ne: "D" },
    });
    products = products.reduce(
      (obj, item) => ((obj[item._id] = item), obj),
      {}
    );
    let category = await makeMongoDbServiceCategory.getDocumentByQuery({
      status: { $ne: "D" },
    });
    category = category.reduce(
      (obj, item) => ((obj[item._id] = item), obj),
      {}
    );
    let cartData = await makeMongoDbServiceCart.getSingleDocumentByIdPopulate(
      cartId,
      null,
      ["cartItems.product"]
    );
    let cartItems = cartData.cartItems;
    const vendorset = new Set();
    let totalItems = 0;
    let itemsGroupedByVendor = {};
    let vendorShippingCosts = {}; // Object to store vendor-wise shipping costs

    for (const productListitem of cartItems) {
      var newProduct = productListitem.product;
      var cartAccountingItem = {};
      cartAccountingItem["productId"] = newProduct._id;
      cartAccountingItem["vendorId"] = newProduct.vendor;
      vendorset.add(newProduct.vendor.toString());
      itemsGroupedByVendor[newProduct.vendor.toString()] = itemsGroupedByVendor[
        newProduct.vendor.toString()
      ]
        ? itemsGroupedByVendor[newProduct.vendor.toString()] +
          productListitem.quantity
        : productListitem.quantity;
      cartAccountingItem["productName"] = newProduct.title || "";
      cartAccountingItem["unitPrice"] = newProduct.total_price || 0;
      let vendor = vendors[newProduct.vendor];
      if (!vendor || !vendor.commission) {
        vendor = { commission: 0 };
      }
      // cartAccountingItem["unitCommission"] =
      //   (cartAccountingItem["unitPrice"] * vendor.commission) / 100;
      // cartAccountingItem["finalUnitPrice"] =
      //   cartAccountingItem["unitPrice"] + cartAccountingItem["unitCommission"];
      cartAccountingItem["quantity"] = productListitem.quantity;
      totalItems += productListitem.quantity;
      cartAccountingItem["bean"] = productListitem.bean;
      cartAccountingItem["totalPrice"] =
        cartAccountingItem["unitPrice"] * cartAccountingItem["quantity"];
      cartAccountingList.push(cartAccountingItem);
    }

    // Calculate shipping costs for each vendor
    for (let vendor of Object.keys(itemsGroupedByVendor)) {
      let vendorShipping = 0;
      for (const productListitem of cartItems) {
        if (productListitem.product.vendor.toString() === vendor) {
          let weight = parseFloat(productListitem.product.weight);
          let unitShippingCost_firstProduct = weight < 15 ? 6 : 10;
          if (itemsGroupedByVendor[vendor] == 1) {
            vendorShipping = unitShippingCost_firstProduct;
          } else {
            vendorShipping =
              unitShippingCost_firstProduct +
              (itemsGroupedByVendor[vendor] - 1) *
                unitShippingCost_nextProducts;
          }
          vendorShippingCosts[vendor] = vendorShipping;
          break; // We only need to calculate this once per vendor
        }
      }
    }

    let finalTotal = 0;
    for (let index = 0; index < cartAccountingList.length; index++) {
      const cartAccountingItem = cartAccountingList[index];
      finalTotal += cartAccountingItem["totalPrice"];
    }

    let totalShippingCost = Object.values(vendorShippingCosts).reduce(
      (acc, cur) => acc + cur,
      0
    );

    finalTotal += totalShippingCost;

    orderAccounting.finalTotal = Number(finalTotal.toFixed(2) || 0);
    // orderAccounting.finalTotal = parseInt(finalTotal);
    orderAccounting.shippingCost = totalShippingCost;
    orderAccounting.cartAccountingList = cartAccountingList;

    // let finalTotalInCents = Math.round(finalTotal * 100);

    // console.log("Formatted finalTotal (display):", orderAccounting.finalTotal); // Should log: "615.56"
    // console.log("Final total in cents (for Stripe):", finalTotalInCents); // Should log: 61556

    // Include vendor-wise shipping costs in the response
    orderAccounting.vendorShippingCosts = vendorShippingCosts;

    let payload = {
      cart_id: cartId,
      amountToCharge: orderAccounting.finalTotal,
      userData: req.user,
    };
    var paymentCred = await createPaymentIntent(payload);
    // var paymentId = paymentCred.id;

    // let shippingAddress = req.body.shippingAddress;
    // let billingAddress = req.body.billingAddress;
    // if (!shippingAddress) {
    //   const user = await makeMongoDbServiceUser.getDocumentById(req.user._id);
    //   shippingAddress = user.address;
    // }
    // if (!billingAddress) {
    //   const user = await makeMongoDbServiceUser.getDocumentById(req.user._id);
    //   billingAddress = user.address;
    // }
    const user = await makeMongoDbServiceUser.getDocumentById(req.user._id);
    let shippingAddress = user.address;
    let billingAddress = user.address;

    // Get the next order number
    const counter = await Counter.findByIdAndUpdate(
      { _id: "orderNumber" },
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    );
    const orderNumber = `DRJ${String(counter.seq).padStart(5, "0")}`;

    const responseData = await makeMongoDbServiceOrder.createDocument({
      user_id: req.user._id,
      cart_id: cartId,
      vendors: Array.from(vendorset),
      vendorNames: Array.from(vendorset).map(
        (id) => `${vendors[id].first_name} ${vendors[id].last_name} ${id}`
      ),
      shippingAddress,
      billingAddress,
      accounting: orderAccounting,
      // paymentId: paymentId,
      payment_status: "I",
      trackingDetails: {},
      orderNumber: orderNumber, // Add this line to store orderNumber
    });
    orderAccounting.cartAccountingList = orderAccounting.cartAccountingList.map(
      (list) => {
        const productDetails = products[list.productId.toString()];
        return {
          ...list,
          productDetails: !productDetails ? {} : productDetails,
        };
      }
    );
    const message = getOrderPlacedMessage({
      ...orderAccounting,
      vendorNames: Array.from(vendorset).map(
        (id) => `${vendors[id].first_name} ${vendors[id].last_name}`
      ),
      shippingAddress,
      billingAddress,
      trackingDetails: {},
      // paymentId,
    });
    // await sendEmail(req.user.email, "Order Placed", message, true);
    let vendorDetails = [];
    let vendorDetail = await makeMongoDbServiceVendor.getDocumentByQuery({
      _id: { $in: Array.from(vendorset) },
    });
    let userAdminDetails = await makeMongoDbServiceUser.getDocumentByQuery({
      _id: { $in: Array.from(vendorset) },
    });
    vendorDetail.forEach((v) => {
      vendorDetails.push(v);
    });
    userAdminDetails.forEach((v) => {
      vendorDetails.push(v);
    });
    vendorDetails = vendorDetails.reduce(
      (obj, item) => ((obj[item._id] = item), obj),
      {}
    );
    orderAccounting.cartAccountingList =
      orderAccounting.cartAccountingList.reduce((group, product) => {
        let { vendorId } = product;
        vendorId = vendorId.toString();
        group[vendorId] = group[vendorId] ?? [];
        group[vendorId].push(product);
        return group;
      }, {});
    let finalGroupedObject = [];
    for (let vendorId of Object.keys(orderAccounting.cartAccountingList)) {
      finalGroupedObject.push({
        vendorDetails: {
          ...vendorDetails[vendorId]._doc,
          shippingCost: vendorShippingCosts[vendorId],
        },
        products: orderAccounting.cartAccountingList[vendorId],
      });
    }
    orderAccounting.cartAccountingList = finalGroupedObject;
    return response(
      false,
      resMessage.success,
      null,
      {
        ...orderAccounting,
        order_id: responseData._id.toString(),
        vendorNames: Array.from(vendorset).map(
          (id) => `${vendors[id].first_name} ${vendors[id].last_name}`
        ),
        shippingAddress,
        billingAddress,
        trackingDetails: {},
        orderNumber: orderNumber,
        paymentId: paymentCred.client_secret,
        stripeSecret: process.env.STRIPE_SECRET,
      },
      200
    );
  } catch (error) {
    console.error("Error in accounting:", error);
    throw new Error("Failed to calculate accounting.");
  }
};

function getOrderPlacedMessage(order) {
  const productList = order.cartAccountingList.map((product) => {
    return `<li>
    // 			Title: ${product.productDetails.title} <br>
    // 			Unit Price: $ ${product.unitPrice} <br>
    // 			Quantity: ${product.quantity} <br>
    // 			Total Price: $ ${product.totalPrice} <br>
    // 		</li>`;
  });

  return `
		Dear customer,<br>
		Your order is placed successfully. Please find the details of your order below: 
		<br>
		<h4>Products List:</h4>
		<ul>
			${productList.join("")}
		</ul>

		<!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Order Placed</title>
    </head>
    <body>
      <section>
      <div class="companyLogo">
      <img src="https://drjacks.coffee/static/media/logo.caf7bd2d66fa6b49d6b2.png"/ width="10%">
    </div>
        <div>
          <h2 style="font-weight: 400; margin-bottom: 20px">Customer FeedBack</h2>
          <table style="width: 500px">
            <tr>
              <td style="width: 20%;">
                <p style="font-weight: 600; margin: 0; ">
                Shipping Address:
                </p>
                </td>
                <td>
              <p style="margin: 0;">${order.shippingAddress}</p>
            </td>
            </tr>
            
          <tr>
            <td style="width: 20%;">
              <p style="font-weight: 600; margin: 0;">
              Billing Address:
              </p>
            </td>
            <td><p style="margin: 0; ">${order.billingAddress}</p></td>
          </tr>
          <tr>
            <td style="width: 20%;">
              <p style="font-weight: 600; margin: 0;">
              Shipping Cost:
              </p>
            </td>
            <td><p style="margin: 0; ">$ ${order.shippingCost}</p></td>
          </tr>
          <tr>
          <td style="width: 20%;">
            <p style="font-weight: 600; margin: 0;">
            Total Price:
            </p>
          </td>
          <td><p style="margin: 0; ">${order.finalTotal}</p></td>
        </tr>
          </table>
          </div>
      
    </section>
  </body>
</html>`;
}

// function getOrderPlacedMessage(order) {
//   const productList = order.cartAccountingList.map((product) => {
//     return `<li>
// 			Title: ${product.productDetails.title} <br>
// 			Unit Price: $ ${product.unitPrice} <br>
// 			Quantity: ${product.quantity} <br>
// 			Total Price: $ ${product.totalPrice} <br>
// 		</li>`;
//   });

//   return `
// 		Dear customer,<br>
// 		Your order is placed successfully. Please find the details of your order below:
// 		<br>
// 		<h4>Products List:</h4>
// 		<ul>
// 			${productList.join("")}
// 		</ul>

// 		<h4>Shipping Address:</h4> ${order.shippingAddress}
// 		<h4>Billing Address:</h4> ${order.billingAddress}
// 		<h4>Shipping Cost:</h4> ${order.shippingCost}
// 		<h4>Final Price:</h4> $ ${order.finalTotal}
// 	`;
// }
