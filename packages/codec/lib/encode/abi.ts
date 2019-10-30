import debugModule from "debug";
const debug = debugModule("codec:encode:abi");

import * as Format from "@truffle/codec/format";
import * as Conversion from "@truffle/codec/conversion";
import * as Evm from "@truffle/codec/evm";
import * as Allocation from "@truffle/codec/allocate/types";
import { abiSizeInfo } from "@truffle/codec/allocate/abi";
import sum from "lodash.sum";
import utf8 from "utf8";

//UGH -- it turns out TypeScript can't handle nested tagged unions
//see: https://github.com/microsoft/TypeScript/issues/18758
//so, I'm just going to have to throw in a bunch of type coercions >_>

/**
 * @Category Encoding (low-level)
 */
export function encodeAbi(
  input: Format.Values.Result,
  allocations?: Allocation.AbiAllocations
): Uint8Array | undefined {
  //errors can't be encoded
  if (input.kind === "error") {
    debug("input: %O", input);
    if (input.error.kind === "IndexedReferenceTypeError") {
      //HACK: errors can't be encoded, *except* for indexed reference parameter errors.
      //really this should go in a different encoding function, not encodeAbi, but I haven't
      //written that function yet.  I'll move this case when I do.
      return Conversion.toBytes(input.error.raw, Evm.Utils.WORD_SIZE);
    } else {
      return undefined;
    }
  }
  let bytes: Uint8Array;
  //TypeScript can at least infer in the rest of this that we're looking
  //at a value, not an error!  But that's hardly enough...
  switch (input.type.typeClass) {
    case "mapping":
    case "magic":
      //neither of these can go in the ABI
      return undefined;
    case "uint":
    case "int":
      return Conversion.toBytes(
        (<Format.Values.UintValue | Format.Values.IntValue>input).value.asBN,
        Evm.Utils.WORD_SIZE
      );
    case "enum":
      return Conversion.toBytes(
        (<Format.Values.EnumValue>input).value.numericAsBN,
        Evm.Utils.WORD_SIZE
      );
    case "bool": {
      bytes = new Uint8Array(Evm.Utils.WORD_SIZE); //is initialized to zeroes
      if ((<Format.Values.BoolValue>input).value.asBoolean) {
        bytes[Evm.Utils.WORD_SIZE - 1] = 1;
      }
      return bytes;
    }
    case "bytes":
      bytes = Conversion.toBytes((<Format.Values.BytesValue>input).value.asHex);
      switch (input.type.kind) {
        case "static":
          let padded = new Uint8Array(Evm.Utils.WORD_SIZE); //initialized to zeroes
          padded.set(bytes);
          return padded;
        case "dynamic":
          return padAndPrependLength(bytes);
      }
    case "address":
      return Conversion.toBytes(
        (<Format.Values.AddressValue>input).value.asAddress,
        Evm.Utils.WORD_SIZE
      );
    case "contract":
      return Conversion.toBytes(
        (<Format.Values.ContractValue>input).value.address,
        Evm.Utils.WORD_SIZE
      );
    case "string": {
      let coercedInput: Format.Values.StringValue = <Format.Values.StringValue>(
        input
      );
      switch (coercedInput.value.kind) {
        case "valid":
          bytes = stringToBytes(coercedInput.value.asString);
          break;
        case "malformed":
          bytes = Conversion.toBytes(coercedInput.value.asHex);
          break;
      }
      return padAndPrependLength(bytes);
    }
    case "function": {
      switch (input.type.visibility) {
        case "internal":
          return undefined; //internal functions can't go in the ABI!
        case "external":
          let coercedInput: Format.Values.FunctionExternalValue = <
            Format.Values.FunctionExternalValue
          >input;
          let encoded = new Uint8Array(Evm.Utils.WORD_SIZE); //starts filled w/0s
          let addressBytes = Conversion.toBytes(
            coercedInput.value.contract.address
          ); //should already be correct length
          let selectorBytes = Conversion.toBytes(coercedInput.value.selector); //should already be correct length
          encoded.set(addressBytes);
          encoded.set(selectorBytes, Evm.Utils.ADDRESS_SIZE); //set it after the address
          return encoded;
      }
    }
    case "fixed":
    case "ufixed":
      let bigValue = (<Format.Values.FixedValue | Format.Values.UfixedValue>(
        input
      )).value.asBig;
      let shiftedValue = Conversion.shiftBigUp(bigValue, input.type.places);
      return Conversion.toBytes(shiftedValue, Evm.Utils.WORD_SIZE);
    case "array": {
      let coercedInput: Format.Values.ArrayValue = <Format.Values.ArrayValue>(
        input
      );
      if (coercedInput.reference !== undefined) {
        return undefined; //circular values can't be encoded
      }
      let staticEncoding = encodeTupleAbi(coercedInput.value, allocations);
      switch (input.type.kind) {
        case "static":
          return staticEncoding;
        case "dynamic":
          let encoded = new Uint8Array(
            Evm.Utils.WORD_SIZE + staticEncoding.length
          ); //leave room for length
          encoded.set(staticEncoding, Evm.Utils.WORD_SIZE); //again, leave room for length beforehand
          let lengthBytes = Conversion.toBytes(
            coercedInput.value.length,
            Evm.Utils.WORD_SIZE
          );
          encoded.set(lengthBytes); //and now we set the length
          return encoded;
      }
    }
    case "struct": {
      let coercedInput: Format.Values.StructValue = <Format.Values.StructValue>(
        input
      );
      if (coercedInput.reference !== undefined) {
        return undefined; //circular values can't be encoded
      }
      return encodeTupleAbi(
        coercedInput.value.map(({ value }) => value),
        allocations
      );
    }
    case "tuple": {
      //WARNING: This case is written in a way that involves a bunch of unnecessary recomputation!
      //(That may not be apparent from this one line, but it's true)
      //I'm writing it this way anyway for simplicity, to avoid rewriting the encoder
      //However it may be worth revisiting this in the future if performance turns out to be a problem
      return encodeTupleAbi(
        (<Format.Values.TupleValue>input).value.map(({ value }) => value),
        allocations
      );
    }
  }
}

export function stringToBytes(input: string): Uint8Array {
  input = utf8.encode(input);
  let bytes = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i++) {
    bytes[i] = input.charCodeAt(i);
  }
  return bytes;
  //NOTE: this will throw an error if the string contained malformed UTF-16!
  //but, well, it shouldn't contain that...
}

function padAndPrependLength(bytes: Uint8Array): Uint8Array {
  let length = bytes.length;
  let paddedLength =
    Evm.Utils.WORD_SIZE * Math.ceil(length / Evm.Utils.WORD_SIZE);
  let encoded = new Uint8Array(Evm.Utils.WORD_SIZE + paddedLength);
  encoded.set(bytes, Evm.Utils.WORD_SIZE); //start 32 in to leave room for the length beforehand
  let lengthBytes = Conversion.toBytes(length, Evm.Utils.WORD_SIZE);
  encoded.set(lengthBytes); //and now we set the length
  return encoded;
}

/**
 * @Category Encoding (low-level)
 */
export function encodeTupleAbi(
  tuple: Format.Values.Result[],
  allocations?: Allocation.AbiAllocations
): Uint8Array | undefined {
  let elementEncodings = tuple.map(element => encodeAbi(element, allocations));
  if (elementEncodings.some(element => element === undefined)) {
    return undefined;
  }
  let elementSizeInfo: Allocation.AbiSizeInfo[] = tuple.map(element =>
    abiSizeInfo(element.type, allocations)
  );
  //heads and tails here are as discussed in the ABI docs;
  //for a static type the head is the encoding and the tail is empty,
  //for a dynamic type the head is the pointer and the tail is the encoding
  let heads: Uint8Array[] = [];
  let tails: Uint8Array[] = [];
  //but first, we need to figure out where the first tail will start,
  //by adding up the sizes of all the heads (we can easily do this in
  //advance via elementSizeInfo, without needing to know the particular
  //values of the heads)
  let startOfNextTail = sum(
    elementSizeInfo.map(elementInfo => elementInfo.size)
  );
  for (let i = 0; i < tuple.length; i++) {
    let head: Uint8Array;
    let tail: Uint8Array;
    if (!elementSizeInfo[i].dynamic) {
      //static case
      head = elementEncodings[i];
      tail = new Uint8Array(); //empty array
    } else {
      //dynamic case
      head = Conversion.toBytes(startOfNextTail, Evm.Utils.WORD_SIZE);
      tail = elementEncodings[i];
    }
    heads.push(head);
    tails.push(tail);
    startOfNextTail += tail.length;
  }
  //finally, we need to concatenate everything together!
  //since we're dealing with Uint8Arrays, we have to do this manually
  let totalSize = startOfNextTail;
  let encoded = new Uint8Array(totalSize);
  let position = 0;
  for (let head of heads) {
    encoded.set(head, position);
    position += head.length;
  }
  for (let tail of tails) {
    encoded.set(tail, position);
    position += tail.length;
  }
  return encoded;
}